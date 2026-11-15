# Notice

## License of this software

The source code of **SEP Reader** (the "Software") is licensed under the
**GNU General Public License v3.0**. See [`LICENSE`](LICENSE) for the full text.

This license applies only to the Software's own source code, assets, and the
entry title/link index that ships with it. It does **not** and **cannot** grant
any rights in the Stanford Encyclopedia of Philosophy's article content (see
below) — those rights are not ours to license.

## Third-party software that ships in the app

- **MathJax** (`mathjax-full`, Apache License 2.0,
  <https://www.apache.org/licenses/LICENSE-2.0>) is bundled as
  `src/assets/mathjax-full.b64`, a base64-encoded build of its `tex-svg-full`
  script. It runs in an off-screen WebView to turn TeX from fetched articles
  into SVG on the user's device. The build keeps the license headers of the
  components it contains (for example the mhchem parser, Copyright 2015-2021
  Martin Hensel, Apache-2.0). This bundle is an engine only; it contains no SEP
  content, and the SVGs it produces are created at runtime and never shipped.

Other dependencies are listed in `package.json` and keep their own licenses.

## No affiliation with Stanford

This application is **unofficial**. It is **not affiliated with, endorsed by, or
sponsored by** Stanford University, the Metaphysics Research Lab, or the editors
of the Stanford Encyclopedia of Philosophy. The names "Stanford" and "Stanford
Encyclopedia of Philosophy" are used only descriptively (nominative fair use) to
identify the content this reader displays. The application's name does not
incorporate the Stanford mark.

## Encyclopedia content is not redistributed

Article content of the Stanford Encyclopedia of Philosophy is
**© the Metaphysics Research Lab, Stanford University**, and is copyrighted by
the Lab and the respective entry authors. The SEP is **not** released under an
open license.

The Software does **not** bundle, embed, or redistribute any SEP article text.
Article content is fetched at runtime, on demand, **onto the user's own device**
directly from `plato.stanford.edu`, and cached there for offline reading — the
same model a web browser or feed reader uses. No build artifact produced from
this repository contains SEP article prose.

## Design constraint: fetch, don't bundle

This is a hard rule, not a preference:

> We distribute the **tool** that fetches and assembles the archive on the
> user's device. We never distribute the encyclopedia's content.

Only the following may ever ship inside a release artifact:

- the application's own source code and assets,
- our own reading CSS and companion JS,
- the entry **title/link index** (slugs and titles — facts, not copyrightable),
- an **empty** SQLite schema.

The following must **never** ship in, or be hosted by us alongside, a release:

- any SQLite/JSON file (or other blob) containing SEP **article bodies**,
  whether bundled in the binary, side-loaded, or downloaded from a server we run.

Hosting the content ourselves would be the same redistribution with our name on
it — it does not launder the copyright. See the CI guard in
[`.github/workflows/no-bundled-content.yml`](.github/workflows/no-bundled-content.yml),
which fails the build if a forbidden content artifact could ship.
