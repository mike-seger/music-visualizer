#!/usr/bin/env bash

index_file="$1/index.json"
index_js="$1/index.js"

function usage() {
	echo "$@"
	echo "Usage: $0 <directory>"
}

function countEntries() {
    cat $1 | jq 'length'
}

function findCandidates() {
    find "$1" -maxdepth 1 ! -type d ! -name index.json -newer "$index_file"
}

[[ -z "$1" || ! -d "$1" ]] && usage && exit 1

# Prefer presets/ subfolder if it exists, otherwise scan top-level
if [[ -d "$1/presets" ]]; then
    scan_dir="$1/presets"
else
    scan_dir="$1"
fi

# Skip index.json regeneration if it exists and is newer than all preset files
skip_json=false
if [[ -f "$index_file" ]]; then
    n=$(findCandidates "$scan_dir" | wc -l)
    if [ $n == 0 ]; then
        echo "$1 index.json is up to date, $(countEntries $index_file) entries." >&2
        skip_json=true
    fi
fi

if [[ "$skip_json" == false ]]; then
# Loop through all files in the directory
(
    # Start the JSON array
    echo "["

    # Counter to track if we need a comma between items
    first_item=true

    find "$scan_dir" -maxdepth 1 \( -type f -o -type l \) -not -name '.*' -exec basename {} \; | while read file; do
	# skip the index itself
        [[ "$file" == "index.json" ]] && continue
        # skip non-JSON files (e.g. .zip downloads, .png previews, etc.)
        [[ "$file" != *.json ]] && continue

        # Get the filename without extension
        name="${file%.*}"
        # Skip dotfiles or entries that lost their name after stripping the extension
        [[ -z "$name" ]] && continue
        # Replace _Mig_ or _mig_ with "mig - " (bash pattern substitution)
        name="${name//_[Mm]ig_/mig - }"
        # (name casing preserved — do not lowercase)

        # Add comma if not the first item
        if [ "$first_item" = true ]; then
            first_item=false
        else
            echo ","
        fi
        
        # Output the JSON object (use %s to safely handle special chars)
        printf '  {\n    "name": "%s",\n    "file": "%s"\n  }' "$name" "$file"
    done

    # Close the JSON array
    echo
    echo "]"
) >"$1"/index.json

echo "$1 has been updated with $(countEntries $index_file) entries." >&2
fi

# --- Generate index.js ---

# Detect preview extension from previews/ directory, default to png
preview_ext="png"
if [[ -d "$1/previews" ]]; then
    first_preview=$(find "$1/previews" -maxdepth 1 -type f -not -name '.*' | head -1)
    if [[ -n "$first_preview" ]]; then
        preview_ext="${first_preview##*.}"
    fi
fi

(
    printf 'const previewExt = "%s";\n' "$preview_ext"
    printf 'const previewMeta = new Map([\n'

    first_item=true

    find "$scan_dir" -maxdepth 1 \( -type f -o -type l \) -not -name '.*' -exec basename {} \; | sort | while read file; do
        [[ "$file" != *.json ]] && continue

        name="${file%.*}"
        [[ -z "$name" ]] && continue

        # Compute 20-char sha256 hex of the file content
        hash=$(shasum -a 256 "$scan_dir/$file" | cut -c1-20)

        # Escape backslashes and double quotes in name for JS string
        escaped_name=$(printf '%s' "$name" | sed 's/\\/\\\\/g; s/"/\\"/g')

        if [ "$first_item" = true ]; then
            first_item=false
        else
            printf ',\n'
        fi

        printf '  ["%s", "%s"]' "$hash" "$escaped_name"
    done

    printf '\n]);\n'
) >"$index_js"

echo "$1/index.js written ($preview_ext previews)." >&2
