# Contributing

ariam connect is the Firefox extension for
[ariam](https://github.com/ariam-dev/ariam), kept for one use (see the
README). Bug reports and small fixes within that scope are welcome.

- Open an [issue](https://github.com/ariam-dev/ariam-connect/issues)
  before a larger change.
- A pull request targets `main`, one change per commit, with a test
  where the code has one (`npm test`), and `npm run lint` clean.
- `src/vendor/` is copied from ariam's status page: change those files
  in ariam, then refresh them with `npm run vendor`.

Contributions are accepted under the MIT license (`LICENSE`). There is
no contributor license agreement.

Report security issues privately; see [SECURITY.md](SECURITY.md).
