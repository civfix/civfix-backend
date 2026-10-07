# Certificate font provenance

These six faces are embedded into the server-rendered service-hours transcript PDF
(`src/services/certificate-pdf.ts`). They are the print counterparts of the civfix brand faces plus the
Korean fallback that keeps a Hangul name or event title from printing as `.notdef` boxes.

**Every file here is a STATIC INSTANCE, never a variable font.** pdfkit/fontkit embed a variable font's
*default instance only*, so a `wght`-axis VF would silently render SemiBold as Regular. `MANIFEST.json`
records a SHA-256 per file and `test/unit/certificate-fonts.test.ts` re-hashes them on every run, which is
the same guarantee civfix-app's `apps/community-web/scripts/copy-contract-fonts.mjs` gives the web app.

Nothing in this directory was instanced, subsetted, renamed or otherwise modified by us: each file is a
byte-for-byte copy of an upstream static release, so the OFL's Reserved Font Name clause is not engaged.
The required copyright notices and the full license text ship beside the fonts in `OFL.txt`.

## The five Latin faces

Google Fonts publishes Baloo 2, Bricolage Grotesque, Hanken Grotesk and JetBrains Mono in
`github.com/google/fonts` as **variable** TTFs only (`Baloo2[wght].ttf`,
`BricolageGrotesque[opsz,wdth,wght].ttf`, `HankenGrotesk[wght].ttf`, `JetBrainsMono[wght].ttf`), which is
exactly the trap described above. The static per-weight instances published by the
`@expo-google-fonts/*` packages (the same files the community mobile app, civfix-app
`apps/community-mobile`, already ships and renders with, so the printed document matches the app) were
vendored instead:

| file | copied from | package version | font version |
|---|---|---|---|
| `Baloo2-ExtraBold.ttf` | `@expo-google-fonts/baloo-2/800ExtraBold/Baloo2_800ExtraBold.ttf` | 0.4.2 | 1.700 |
| `BricolageGrotesque-SemiBold.ttf` | `@expo-google-fonts/bricolage-grotesque/600SemiBold/BricolageGrotesque_600SemiBold.ttf` | 0.4.1 | 1.001 |
| `HankenGrotesk-Regular.ttf` | `@expo-google-fonts/hanken-grotesk/400Regular/HankenGrotesk_400Regular.ttf` | 0.4.3 | 3.013 |
| `HankenGrotesk-SemiBold.ttf` | `@expo-google-fonts/hanken-grotesk/600SemiBold/HankenGrotesk_600SemiBold.ttf` | 0.4.3 | 3.013 |
| `JetBrainsMono-Regular.ttf` | `@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf` | 0.4.1 | 2.211 |

Verified static, not variable, at vendoring time (fontkit): each file reports zero variation axes and the
`OS/2.usWeightClass` in the table above's file name (400 / 600 / 800).

- Upstream families and licenses:
  - Baloo 2: https://github.com/EkType/Baloo2 · https://github.com/google/fonts/tree/main/ofl/baloo2
  - Bricolage Grotesque: https://github.com/ateliertriay/bricolage ·
    https://github.com/google/fonts/tree/main/ofl/bricolagegrotesque
  - Hanken Grotesk: https://github.com/marcologous/hanken-grotesk ·
    https://github.com/google/fonts/tree/main/ofl/hankengrotesk
  - JetBrains Mono: https://github.com/JetBrains/JetBrainsMono ·
    https://github.com/google/fonts/tree/main/ofl/jetbrainsmono

## The Korean fallback

| file | source | revision |
|---|---|---|
| `NotoSansKR-Regular.otf` | https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf | `f8d157532fbfaeda587e826d4cd5b21a49186f7c` (2024-09-19) |

- SHA-256: `69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68` (4 644 748 bytes)
- License at that revision:
  https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE
- Font version 2.004 (`makeotfexe`), copyright "© 2014-2021 Adobe (http://www.adobe.com/)".

**Why `.otf` and not `.ttf`.** Noto Sans KR has no static TTF anywhere upstream: `google/fonts` ships only
`NotoSansKR[wght].ttf` (variable, 10.4 MB) and `notofonts/noto-cjk` ships statics as CFF-flavoured OpenType
(`Sans/SubsetOTF/KR/*.otf`). Instancing the variable font would need `fonttools varLib.instancer`, i.e.
Python, which the `node:22-bookworm-slim` runtime image does not have, and instancing at build time is
forbidden for exactly that reason. pdfkit/fontkit embed and subset CFF OpenType as happily as TrueType
(`Type0` / `CIDFontType0`), which the Hangul fixture in `test/unit/certificate-pdf.test.ts` proves on every
run. The `SubsetOTF` in the upstream path means "Korean subset of the pan-CJK family", not "already
subsetted for us"; fontkit still subsets it per document.

Only the Regular weight is vendored, deliberately: a CJK Bold would add another ~4.8 MB to the image for
one typographic nuance, so CJK headings render Regular.

## Re-vendoring checklist

1. Replace the file with a fresh upstream **static** copy.
2. `shasum -a 256 <file>` and update `MANIFEST.json`.
3. Update the revision/version row above.
4. `pnpm --filter @civfix/api test certificate-`: the manifest re-hash, the size bounds (no 0-byte file,
   nothing over 8 MB, which is how a committed Git-LFS pointer gets caught) and the Hangul render all run
   there.
5. `pnpm --filter @civfix/api render:sample-certificate` and eyeball the output (written to
   `/tmp/civfix-cert` by default).
