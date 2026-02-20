# Developer Tools

Scripts in the `scripts/` directory that support preset management and analysis.

---

## hash-presets.mjs

Computes the same stable SHA-256 content hash the app uses to key captured
previews, for one or more preset JSON files.  The hash is the first 12 hex
characters of the SHA-256 digest of the raw file text (UTF-8) — identical to
the in-browser `_sha256short()` function in `src/js/preview/PreviewBatch.js`.

### Usage

```
node scripts/hash-presets.mjs [options] <path>
```

`<path>` is either a single `.json` file or a directory.  When a directory is
given, only its **top-level** `.json` files are included (no recursion).

### Options

| Flag | Default | Description |
|---|---|---|
| `--format json` | ✓ | Output a JSON array |
| `--format tsv` | | Output tab-separated values with a header row |
| `--out <file>` | stdout | Write output to `<file>` instead of stdout |
| `--help` | | Show usage message |

### Output columns

| Column | Description |
|---|---|
| `hash12` | First 12 hex chars of SHA-256 — the key used by the app |
| `hashfull` | Full 64-char hex SHA-256 digest |
| `file` | Basename of the JSON file (e.g. `martin - witchcraft.json`) |

### Examples

```bash
# Hash every preset in a group directory — JSON output to stdout
node scripts/hash-presets.mjs public/butterchurn-presets/top

# Same, as TSV written to a file
node scripts/hash-presets.mjs public/butterchurn-presets/top \
  --format tsv --out /tmp/top-hashes.tsv

# Hash a single file
node scripts/hash-presets.mjs "public/butterchurn-presets/top/martin - witchcraft reloaded.json"

# Hash all presets in the cream-of-the-crop group, TSV to stdout
node scripts/hash-presets.mjs public/butterchurn-presets/cream-of-the-crop \
  --format tsv
```

### Sample JSON output

```json
[
  {
    "hash12": "5910993c73cf",
    "hashfull": "5910993c73cf04ef83c0679c9fc3005203662bb0084f3863bd26005314a21649",
    "file": "Martin - QBikal - Surface Turbulence.json"
  },
  ...
]
```

### Sample TSV output

```
hash12	hashfull	file
5910993c73cf	5910993c73cf04ef83c0679c9fc3005203662bb0084f3863bd26005314a21649	Martin - QBikal - Surface Turbulence.json
f760d5102b07	f760d5102b072f54505e3ff092f805e2a9c0dc05d5948b4b8f94b420a3eb9a87	martin - Thinking about you.json
```

### Notes

- The hash is **content-based**: if the file bytes change, the hash changes.
  Renaming a file does not affect its hash.
- `index.json` and other non-preset JSON files in a directory are included by
  the script since it does no filtering by content — pipe through `grep -v` or
  use a single-file invocation to exclude them if needed.
- The hash is guaranteed to match the key stored in `previews/index.js` for any
  preset that has already been captured by the app.
