# Historical ancestry corrections

Package state follows each source's first-parent history. A few historical
maintainer pulls put the already published upstream branch in the second parent,
so for the merges below `src/sources/history.ts` follows parent two instead. Each
entry pins both parent SHAs, and a mismatch fails the crawl. The list is closed;
changing it requires a `HISTORY_MODEL` bump and a full reseed.

| Merge | Published parent | Evidence |
| --- | --- | --- |
| core `dbf81ea4` | `7debfcb3` | [PR 515](https://github.com/Homebrew/homebrew-core/pull/515) merge commit |
| core `d4cc0feb` | `f2e951bd` | [legacy PR 9983](https://api.github.com/repos/Homebrew/legacy-homebrew/issues/9983/events), same ngspice blob |
| core `31ffb7af` | `9d709ffe` | [legacy PR 9080](https://api.github.com/repos/Homebrew/legacy-homebrew/issues/9080/events), same wine blob |
| cask `ee51d5d1` | `5097cd00` | [PR 84810](https://github.com/Homebrew/homebrew-cask/pull/84810) merge commit |
| cask `0c6faf86` | `fdf00102` | [PR 1518](https://api.github.com/repos/Homebrew/homebrew-cask/issues/1518/events) merge event |
| cask `e9447b51` | `08f90e39` | [PR 1496](https://api.github.com/repos/Homebrew/homebrew-cask/issues/1496/events) merge event |
| cask `6a7ea043` | `7f57a1db` | [PR 1100](https://api.github.com/repos/Homebrew/homebrew-cask/issues/1100/events) merge event |

Three similar core merges (`acfe1645`, `ef4e2e60`, `1ce611b4`) lack publication
evidence and keep first-parent history.
