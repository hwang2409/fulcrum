# third-party notices

`@fulcrum/highlight` contains bundled shiki code and textmate grammar data. copyright remains with each project and its contributors.

## bundled code

| project | version | license |
|---|---:|---|
| shiki, `@shikijs/core`, `@shikijs/primitive`, `@shikijs/types`, `@shikijs/engine-javascript`, `@shikijs/langs` | 4.6.0 | mit |
| `@shikijs/vscode-textmate` | 10.1.0 | mit |
| `oniguruma-to-es` | 4.3.6 | mit |
| `oniguruma-parser` | 0.12.2 | mit |
| `regex` | 6.1.0 | mit |
| `regex-recursion` | 6.0.2 | mit |
| `regex-utilities` | 2.3.0 | mit |
| `ccount`, `character-entities-html4`, `character-entities-legacy`, `stringify-entities` | 2.0.1, 2.1.0, 3.0.0, 4.0.4 | mit |
| `comma-separated-tokens`, `hast-util-whitespace`, `html-void-elements`, `space-separated-tokens`, `zwitch` | 2.0.3, 3.0.0, 3.0.0, 2.0.2, 2.0.4 | mit |
| `hast-util-to-html`, `property-information` | 9.0.6, 7.2.0 | mit |

copyright notices:

- shiki: copyright (c) 2021 Pine Wu; copyright (c) 2023 Anthony Fu <https://github.com/antfu>
- `@shikijs/vscode-textmate`: copyright (c) Microsoft Corporation
- `oniguruma-to-es`: copyright (c) 2024-2026 Steven Levithan
- `oniguruma-parser`: copyright (c) 2025-2026 Steven Levithan
- `regex` and `regex-recursion`: copyright (c) 2025 Steven Levithan
- `regex-utilities`: copyright (c) 2024 Steven Levithan
- `ccount`, `character-entities-html4`, and `character-entities-legacy`: copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `stringify-entities`: copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>
- `comma-separated-tokens`, `hast-util-whitespace`, `html-void-elements`, `space-separated-tokens`, and `zwitch`: copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `hast-util-to-html`: copyright (c) Titus Wormer <tituswormer@gmail.com>
- `property-information`: copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>

## bundled grammars

this list follows the upstream `tm-grammars` notice. each grammar is loaded as a separate lazy chunk.

| grammar files | upstream | license |
|---|---|---|
| c, c++, css, diff, dockerfile, go, ini, java, javascript, json, jsx, lua, makefile, markdown, php, python, ruby, rust, shell, sql, tsx, typescript, xml | microsoft vscode built-in grammars | mit |
| html | onivim vscode exthost html grammar | mit |
| graphql | graphql vscode grammar | mit |
| kotlin | fwcd vscode-kotlin | mit |
| protobuf | zxh0 vscode-proto3 | mit |
| swift | jtbandes swift-tmlanguage | mit |
| toml | better toml textmate grammar | mit |
| yaml | red hat yaml textmate grammar | mit |

source and license references:

- https://github.com/shikijs/shiki
- https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-grammars/NOTICE
- https://github.com/microsoft/vscode/blob/main/LICENSE.txt
- https://github.com/onivim/vscode-exthost/blob/master/LICENSE.txt
- https://github.com/graphql/vscode-graphql/blob/master/LICENSE
- https://github.com/fwcd/vscode-kotlin/blob/main/LICENSE
- https://github.com/zxh0/vscode-proto3/blob/master/LICENSE.txt
- https://github.com/jtbandes/swift-tmlanguage/blob/main/LICENSE.md

## mit license

permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "software"), to deal in the software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software, and to permit persons to whom the software is furnished to do so, subject to the following conditions:

the above copyright notice and this permission notice shall be included in all copies or substantial portions of the software.

the software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. in no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.
