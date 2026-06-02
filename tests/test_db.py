"""Validate the prebuilt termose.duckdb: id PK + FTS index + runtime SQL.

The SQL strings here are the canonical queries db.js mirrors. If you change a
query in db.js, change it here too (and vice-versa)."""
from pathlib import Path

import duckdb
import pytest

DB = str(Path(__file__).resolve().parent.parent / "database" / "termose.duckdb")
TABLES = ["cim10", "ccam", "adicap", "atc"]


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect(DB, read_only=True)
    c.execute("LOAD fts;")
    yield c
    c.close()


def test_meta_lists_all_terminologies(con):
    rows = con.execute(
        "SELECT table_name, version FROM meta ORDER BY table_name"
    ).fetchall()
    names = [r[0] for r in rows]
    assert names == ["adicap", "atc", "ccam", "cim10"]


def test_meta_has_license_attribution(con):
    # Each terminology must carry a non-empty license for CC BY-NC-ND attribution.
    rows = con.execute(
        "SELECT table_name, source, license, license_url FROM meta ORDER BY table_name"
    ).fetchall()
    for table_name, source, license_, _url in rows:
        assert license_, f"{table_name}: licence manquante"


@pytest.mark.parametrize("table", TABLES)
def test_id_is_unique_primary_key(con, table):
    n, distinct, nulls = con.execute(
        f"SELECT count(*), count(DISTINCT id), count(*) FILTER (WHERE id IS NULL) "
        f"FROM {table}"
    ).fetchone()
    assert distinct == n and nulls == 0  # id is a non-null unique key


@pytest.mark.parametrize("table", TABLES)
def test_roots_exist(con, table):
    rows = con.execute(
        f"SELECT id, code, label, depth, lft, rgt, path, concept_count, freq_abs, freq_rel "
        f"FROM {table} WHERE depth = 0 ORDER BY lft"
    ).fetchall()
    assert len(rows) >= 1
    assert all(r[3] == 0 for r in rows)  # depth == 0


@pytest.mark.parametrize("table", TABLES)
def test_children_of_a_root(con, table):
    root_path, root_depth = con.execute(
        f"SELECT path, depth FROM {table} WHERE depth = 0 ORDER BY lft LIMIT 1"
    ).fetchone()
    kids = con.execute(
        f"SELECT id, depth FROM {table} "
        f"WHERE path LIKE ? AND depth = ? ORDER BY lft",
        [root_path + "/%", root_depth + 1],
    ).fetchall()
    assert len(kids) >= 1
    assert all(k[1] == root_depth + 1 for k in kids)


@pytest.mark.parametrize("table", TABLES)
def test_fts_index_present_and_ranks(con, table):
    # Deterministically pick a real alphabetic keyword token (>=4 letters) so the
    # probe survives the tokenizer (it drops pure-digit tokens like "00").
    word = con.execute(
        f"SELECT word FROM ("
        f"  SELECT unnest(string_split(keywords, ' ')) AS word, lft FROM {table} "
        f"  WHERE keywords IS NOT NULL"
        f") WHERE regexp_matches(word, '^[a-z]{{4,}}$') ORDER BY lft LIMIT 1"
    ).fetchone()[0]
    rows = con.execute(
        f"SELECT id, code, label, freq_abs, "
        f"fts_main_{table}.match_bm25(id, ?, conjunctive := 1) AS score "
        f"FROM {table} WHERE score IS NOT NULL "
        f"ORDER BY score DESC, freq_abs DESC LIMIT 300",
        [word],
    ).fetchall()
    assert len(rows) >= 1
    assert rows[0][4] is not None  # has a BM25 score


@pytest.mark.parametrize("table", TABLES)
def test_frequency_columns(con, table):
    # Derived usage columns. These invariants hold whether or not usage counts were
    # loaded (with no counts everything is 0). Note freq_rel may exceed 1 in theory
    # (adicap codes appear under several parents), so we only floor it at 0.
    bad = con.execute(
        f"SELECT count(*) FROM {table} "
        f"WHERE concept_count < 0 OR freq_abs < 0 OR freq_abs > 1 OR freq_rel < 0"
    ).fetchone()[0]
    assert bad == 0
    # Roots have no parent: freq_rel mirrors freq_abs (share of the grand total).
    root_mismatch = con.execute(
        f"SELECT count(*) FROM {table} WHERE depth = 0 AND abs(freq_rel - freq_abs) > 1e-9"
    ).fetchone()[0]
    assert root_mismatch == 0
    # Nested-set aggregation: a node's concept_count equals the sum of its
    # descendant-or-self LEAF counts. The full-tree root subtree is representative.
    root_lft, root_rgt, root_cc = con.execute(
        f"SELECT lft, rgt, concept_count FROM {table} WHERE depth = 0 ORDER BY lft LIMIT 1"
    ).fetchone()
    leaf_sum = con.execute(
        f"SELECT COALESCE(SUM(concept_count), 0) FROM {table} "
        f"WHERE lft >= ? AND rgt <= ? AND (rgt - lft) = 1",
        [root_lft, root_rgt],
    ).fetchone()[0]
    assert root_cc == leaf_sum


@pytest.mark.parametrize("table", TABLES)
def test_concept_and_ancestors(con, table):
    # A node at depth >= 2 so it has ancestors.
    node = con.execute(
        f"SELECT id, lft, rgt FROM {table} WHERE depth >= 2 ORDER BY lft LIMIT 1"
    ).fetchone()
    node_id, lft, rgt = node
    one = con.execute(f"SELECT * FROM {table} WHERE id = ?", [node_id]).fetchone()
    assert one is not None
    anc = con.execute(
        f"SELECT id, code, label FROM {table} "
        f"WHERE lft < ? AND rgt > ? ORDER BY lft",
        [lft, rgt],
    ).fetchall()
    assert len(anc) >= 1  # at least the chapter above it


def test_ccam_labels_have_no_code_prefix(con):
    # Temporary patch in build_db.py strips the "<code> " prefix from CCAM labels.
    n = con.execute(
        "SELECT count(*) FROM ccam WHERE starts_with(label, code || ' ')"
    ).fetchone()[0]
    assert n == 0
