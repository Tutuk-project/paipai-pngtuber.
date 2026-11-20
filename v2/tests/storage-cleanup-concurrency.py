#!/usr/bin/env python3
"""Isolated PostgreSQL concurrency tests for Vio Storage cleanup guards.

Uses only a disposable CI PostgreSQL database. Never connects to Supabase.
"""
import os
import threading
import time
import psycopg
from psycopg.errors import ObjectNotInPrerequisiteState

DSN = os.environ["VIO_TEST_DATABASE_URL"]
MIGRATION = os.path.join(os.path.dirname(__file__), "..", "supabase", "migrations", "006_vio_storage_cleanup_reference_guard.sql")

def connect():
    return psycopg.connect(DSN)

def setup():
    with connect() as conn:
        conn.execute("drop table if exists public.vio_character_assets cascade")
        conn.execute("drop table if exists public.vio_character_accessories cascade")
        conn.execute("drop table if exists public.vio_profiles cascade")
        conn.execute("drop table if exists public.vio_storage_cleanup_queue cascade")
        conn.execute("create table public.vio_storage_cleanup_queue (id bigserial primary key, bucket_id text not null, storage_path text not null, processed_at timestamptz, unique(bucket_id, storage_path))")
        conn.execute("create table public.vio_character_assets (id bigserial primary key, bucket_id text not null, storage_path text not null)")
        conn.execute("create table public.vio_character_accessories (id bigserial primary key, bucket_id text not null, storage_path text not null)")
        conn.execute("create table public.vio_profiles (user_id bigserial primary key, preferences jsonb not null default '{}'::jsonb)")
        conn.execute("create role anon")
        conn.execute("create role authenticated")
        conn.execute(open(MIGRATION, encoding="utf-8").read())
        conn.commit()

def wait_until_advisory_wait(pid, timeout=5):
    deadline = time.monotonic() + timeout
    with connect() as observer:
        while time.monotonic() < deadline:
            row = observer.execute(
                "select wait_event_type, wait_event from pg_stat_activity where pid = %s",
                (pid,),
            ).fetchone()
            if row and row[0] == "Lock" and row[1] == "advisory":
                return
            time.sleep(0.02)
    raise AssertionError(f"backend {pid} did not wait on advisory lock")

def test_queue_reservation_wins():
    bucket, path = "vio-studio-assets", "race/queue-wins.png"
    with connect() as first:
        first.execute("insert into public.vio_storage_cleanup_queue(bucket_id, storage_path) values (%s, %s)", (bucket, path))
        pid_ready = threading.Event()
        result = {}

        def add_reference():
            try:
                with connect() as second:
                    result["pid"] = second.execute("select pg_backend_pid()").fetchone()[0]
                    pid_ready.set()
                    second.execute("insert into public.vio_character_assets(bucket_id, storage_path) values (%s, %s)", (bucket, path))
                    second.commit()
                result["outcome"] = "inserted"
            except Exception as error:
                result["outcome"] = error

        worker = threading.Thread(target=add_reference)
        worker.start()
        assert pid_ready.wait(3), "reference transaction did not start"
        wait_until_advisory_wait(result["pid"])
        first.commit()
        worker.join(5)
        assert not worker.is_alive(), "reference transaction remained blocked"
        assert isinstance(result.get("outcome"), ObjectNotInPrerequisiteState), f"expected SQLSTATE 55000, got {result.get('outcome')!r}"
    print("PASS queue reservation wins: concurrent new reference rejected")

def test_reference_wins():
    bucket, path = "vio-studio-assets", "race/reference-wins.png"
    with connect() as first:
        first.execute("insert into public.vio_character_accessories(bucket_id, storage_path) values (%s, %s)", (bucket, path))
        pid_ready = threading.Event()
        result = {}

        def enqueue():
            try:
                with connect() as second:
                    result["pid"] = second.execute("select pg_backend_pid()").fetchone()[0]
                    pid_ready.set()
                    second.execute("insert into public.vio_storage_cleanup_queue(bucket_id, storage_path) values (%s, %s)", (bucket, path))
                    second.commit()
                result["outcome"] = "queued"
            except Exception as error:
                result["outcome"] = error

        worker = threading.Thread(target=enqueue)
        worker.start()
        assert pid_ready.wait(3), "queue transaction did not start"
        wait_until_advisory_wait(result["pid"])
        first.commit()
        worker.join(5)
        assert not worker.is_alive(), "queue transaction remained blocked"
        assert result.get("outcome") == "queued", f"queue insert failed: {result.get('outcome')!r}"
        with connect() as check:
            still_referenced = check.execute(
                "select exists(select 1 from public.vio_character_accessories where bucket_id=%s and storage_path=%s)",
                (bucket, path),
            ).fetchone()[0]
            assert still_referenced, "reference disappeared unexpectedly"
    print("PASS reference wins: cleanup queue observes committed reference")

def test_all_reference_tables_block_pending_queue():
    with connect() as conn:
        conn.execute("insert into public.vio_storage_cleanup_queue(bucket_id, storage_path) values ('vio-studio-assets', 'race/asset.png'), ('vio-backgrounds', 'race/bg.png')")
        checks = [
            ("insert into public.vio_character_assets(bucket_id, storage_path) values ('vio-studio-assets', 'race/asset.png')",),
            ("insert into public.vio_character_accessories(bucket_id, storage_path) values ('vio-studio-assets', 'race/asset.png')",),
            ("insert into public.vio_profiles(preferences) values ('{"background":{"bucket_id":"vio-backgrounds","storage_path":"race/bg.png"}}'::jsonb)",),
        ]
        for (statement,) in checks:
            try:
                conn.execute(statement)
            except ObjectNotInPrerequisiteState:
                conn.rollback()
            else:
                raise AssertionError(f"pending cleanup did not block: {statement}")
        conn.commit()
    print("PASS all metadata reference triggers reject pending objects")

def test_processed_queue_releases_reservation():
    with connect() as conn:
        conn.execute("insert into public.vio_storage_cleanup_queue(bucket_id, storage_path, processed_at) values ('vio-studio-assets', 'race/released.png', now())")
        conn.execute("insert into public.vio_character_assets(bucket_id, storage_path) values ('vio-studio-assets', 'race/released.png')")
        conn.commit()
    print("PASS processed cleanup job releases object reservation")

if __name__ == "__main__":
    setup()
    test_queue_reservation_wins()
    test_reference_wins()
    test_all_reference_tables_block_pending_queue()
    test_processed_queue_releases_reservation()
    print("Validated 4 PostgreSQL cleanup concurrency scenarios.")
