[![sokoban-solver-01-run-20261121 on make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/nguyentran113/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/nguyentran113/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# sokoban-solver-01

A push-optimal Sokoban solver for the make.fun bounty
[sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121).
`main.ts` (plain JavaScript, no dependencies) runs as `node /bot/main.ts` on
Node 22: it reads every instance under `/input/<id>/level.txt` (XSB) and writes
`/output/<id>/solution.txt` with the player's moves in LURD, an upper-case
letter marking a push.

## How it solves

Scores reward the fewest **pushes**, not the fewest moves, so the search runs
over pushes: a state is the sorted box squares plus the player's reachable
region (named by its lowest square).

1. **Room decomposition.** The levels this contest draws are a hallway with
   small rooms off it, and a box can never leave its room (a push through a
   door strands it in the hallway, from which no goal is reachable). Cutting
   the dead squares of the player's own row out of the floor splits the level
   into its rooms; each room is then solved on its own and the optima add up
   to the level's optimum. Any level that does not split cleanly falls back
   to a whole-level search.
2. **Push A\*.** Each room is searched with A\* over pushes. The heuristic is
   a minimum-cost matching (Hungarian algorithm) between boxes and goals,
   where the cost of a box–goal pair is the true number of pushes that box
   alone needs to reach that goal, precomputed per goal by a reverse breadth
   search over the push graph. That matching is a lower bound on the pushes
   still needed, so the first solution A\* settles on is push-optimal.
3. **Deadlock pruning.** Boxes pushed onto dead squares (squares from which
   no push sequence reaches any goal) and frozen 2×2 blocks of walls and
   boxes with a box off its goal are cut as soon as they appear.
4. **Work budgets, never the clock.** Every search is capped by an expansion
   count, and a plain breadth-first push search stands behind A\* as a second
   engine. The program reads no clock, no randomness and nothing outside
   `/input`, so two executions write byte-identical answers.
