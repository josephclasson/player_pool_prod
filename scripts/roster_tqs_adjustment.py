#!/usr/bin/env python3
"""
Post-tournament roster quality adjustment (TQS) — reference implementation.

This mirrors the TypeScript logic in:
  lib/scoring/roster-tqs-adjustment.ts
  lib/scoring/persist-league-scoreboard.ts

Database wiring (Supabase / Postgres example):
  - teams table: id, name, overall_rank (1–68), seed (1–16), ...
  - player_draft_picks + players: map each roster slot to team_id
  - league_team / scoreboard: raw_total per owner roster

  1) SELECT teams into a DataFrame: team_id, overall_rank, seed
  2) SELECT roster rows: owner_id, raw_total, plus eight team_id columns OR long-form
  3) calculate_tqs(teams_df)  -> adds `tqs`
  4) calculate_roster_tqs(rosters_df, teams_df)  -> adds `roster_tqs`
  5) calculate_adjustments(...)  -> adjustment, final_score

Dependencies:
  pip install pandas

Run:
  python scripts/roster_tqs_adjustment.py
"""

from __future__ import annotations

import pandas as pd

# ---------------------------------------------------------------------------
# Tunable constants (keep in sync with roster-tqs-adjustment.ts when possible)
# ---------------------------------------------------------------------------

# Weight on NCAA overall S-curve rank (1 = best … 68 = worst).
W_R: float = 1.0

# Weight on regional pod seed (1 = best … 16 = worst). ~2× rank: harder paths for low seeds.
W_S: float = 2.0

# adjustment = K * (league_avg_roster_tqs - roster_tqs)
# Tune K against typical raw totals:
#   - If raw roster totals are often ~200–400 fantasy points, try K between 0.8 and 1.5.
#   - Raise K if adjustments feel too small; lower if they dominate the standings.
K: float = 1.0


def calculate_tqs(
    team_df: pd.DataFrame,
    w_r: float = W_R,
    w_s: float = W_S,
    overall_col: str = "overall_rank",
    seed_col: str = "seed",
) -> pd.DataFrame:
    """
    Per-team Team Quality Score:
        TQS = w_r * (69 - overall_rank) + w_s * (17 - seed)

    Expects team_df rows for each NCAA team with valid overall_rank in [1, 68]
    and seed in [1, 16]. Invalid rows get NaN tqs.
    """
    out = team_df.copy()
    r = pd.to_numeric(out[overall_col], errors="coerce")
    s = pd.to_numeric(out[seed_col], errors="coerce")
    valid = (r >= 1) & (r <= 68) & (s >= 1) & (s <= 16)
    out["tqs"] = pd.NA
    out.loc[valid, "tqs"] = w_r * (69 - r[valid]) + w_s * (17 - s[valid])
    return out


def calculate_roster_tqs(
    rosters_df: pd.DataFrame,
    teams_with_tqs: pd.DataFrame,
    team_id_cols: list[str],
    team_key: str = "team_id",
    tqs_col: str = "tqs",
) -> pd.DataFrame:
    """
    Roster_TQS = mean TQS of drafted teams on that roster.

    rosters_df: one row per fantasy roster; must include team_id_cols e.g.
      t1, t2, ... t8 referencing teams_with_tqs[team_key].
    teams_with_tqs: output of calculate_tqs (has tqs per team).
    """
    tqs_by_id = teams_with_tqs.set_index(team_key)[tqs_col]

    def mean_tqs_for_row(row: pd.Series) -> float:
        vals: list[float] = []
        for c in team_id_cols:
            tid = row.get(c)
            if pd.isna(tid):
                continue
            v = tqs_by_id.get(int(tid), pd.NA)
            if pd.notna(v):
                vals.append(float(v))
        return sum(vals) / len(vals) if vals else float("nan")

    out = rosters_df.copy()
    out["roster_tqs"] = out.apply(mean_tqs_for_row, axis=1)
    return out


def calculate_adjustments(
    rosters_with_raw_scores_df: pd.DataFrame,
    team_df: pd.DataFrame,
    w_r: float = W_R,
    w_s: float = W_S,
    k: float = K,
    raw_col: str = "raw_total_score",
    roster_name_col: str = "roster_name",
    team_id_cols: list[str] | None = None,
) -> pd.DataFrame:
    """
    League baseline: mean of roster_tqs over rosters with a defined roster_tqs.

    adjustment = k * (league_avg_roster_tqs - roster_tqs)
    final_score = raw_total_score + adjustment
    """
    if team_id_cols is None:
        team_id_cols = [f"t{i}" for i in range(1, 9)]

    teams_tqs = calculate_tqs(team_df, w_r=w_r, w_s=w_s)
    r = calculate_roster_tqs(rosters_with_raw_scores_df, teams_tqs, team_id_cols)
    league_avg = r["roster_tqs"].mean(skipna=True)
    r["league_avg_roster_tqs"] = league_avg
    r["adjustment"] = k * (league_avg - r["roster_tqs"])
    r["final_score"] = pd.to_numeric(r[raw_col], errors="coerce") + r["adjustment"]
    return r


def _sample_teams_68() -> pd.DataFrame:
    """Synthetic 68-team field: overall_rank 1..68, seed cycles 1..16."""
    rows = []
    for overall in range(1, 69):
        seed = ((overall - 1) % 16) + 1
        rows.append(
            {
                "team_id": overall,
                "team_name": f"Team_{overall}",
                "overall_rank": overall,
                "seed": seed,
            }
        )
    return pd.DataFrame(rows)


def _sample_rosters() -> pd.DataFrame:
    """Eight fantasy rosters with eight team_ids each and raw totals."""
    return pd.DataFrame(
        [
            {
                "roster_name": "Alice",
                "raw_total_score": 312.0,
                "t1": 1,
                "t2": 5,
                "t3": 9,
                "t4": 13,
                "t5": 17,
                "t6": 25,
                "t7": 33,
                "t8": 41,
            },
            {
                "roster_name": "Bob",
                "raw_total_score": 298.0,
                "t1": 2,
                "t2": 6,
                "t3": 10,
                "t4": 14,
                "t5": 18,
                "t6": 26,
                "t7": 34,
                "t8": 42,
            },
            {
                "roster_name": "Carla",
                "raw_total_score": 340.0,
                "t1": 3,
                "t2": 7,
                "t3": 11,
                "t4": 15,
                "t5": 60,
                "t6": 61,
                "t7": 62,
                "t8": 63,
            },
            {
                "roster_name": "Dan",
                "raw_total_score": 275.0,
                "t1": 50,
                "t2": 51,
                "t3": 52,
                "t4": 53,
                "t5": 54,
                "t6": 55,
                "t7": 56,
                "t8": 57,
            },
            {
                "roster_name": "Elena",
                "raw_total_score": 305.0,
                "t1": 4,
                "t2": 8,
                "t3": 12,
                "t4": 16,
                "t5": 20,
                "t6": 28,
                "t7": 36,
                "t8": 44,
            },
            {
                "roster_name": "Frank",
                "raw_total_score": 288.0,
                "t1": 21,
                "t2": 22,
                "t3": 23,
                "t4": 24,
                "t5": 29,
                "t6": 30,
                "t7": 31,
                "t8": 32,
            },
            {
                "roster_name": "Gina",
                "raw_total_score": 318.0,
                "t1": 37,
                "t2": 38,
                "t3": 39,
                "t4": 40,
                "t5": 45,
                "t6": 46,
                "t7": 47,
                "t8": 48,
            },
            {
                "roster_name": "Hassan",
                "raw_total_score": 292.0,
                "t1": 64,
                "t2": 65,
                "t3": 66,
                "t4": 67,
                "t5": 68,
                "t6": 58,
                "t7": 59,
                "t8": 49,
            },
        ]
    )


def main() -> None:
    teams_df = _sample_teams_68()
    rosters_df = _sample_rosters()
    team_cols = [f"t{i}" for i in range(1, 9)]

    result = calculate_adjustments(rosters_df, teams_df, w_r=W_R, w_s=W_S, k=K, team_id_cols=team_cols)

    display_cols = [
        "roster_name",
        "raw_total_score",
        "roster_tqs",
        "league_avg_roster_tqs",
        "adjustment",
        "final_score",
    ]
    print("TQS adjustment summary (defaults W_R=1, W_S=2, K=1):\n")
    # Round for readability
    out = result[display_cols].copy()
    out["roster_tqs"] = out["roster_tqs"].round(3)
    out["league_avg_roster_tqs"] = out["league_avg_roster_tqs"].round(3)
    out["adjustment"] = out["adjustment"].round(2)
    out["final_score"] = out["final_score"].round(2)
    print(out.to_string(index=False))


if __name__ == "__main__":
    main()
