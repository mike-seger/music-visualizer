#!/usr/bin/env bash

index_file="$1/index.json"

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

# Skip if index.json exists and is newer than all other files in the directory
if [[ -f "$index_file" ]]; then
    n=$(findCandidates "$1" | wc -l)
    if [ $n == 0 ]; then
        echo "$1 is up to date, $(countEntries $index_file) entries." >&2
        exit 0
    fi
fi

# Loop through all files in the directory
(
    # Start the JSON array
    echo "["

    # Counter to track if we need a comma between items
    first_item=true

    find "$1" -maxdepth 1 \( -type f -o -type l \) -not -name '.*' -exec basename {} \; | while read file; do
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
        # Lowercase (bash 4+)
        name="${name,,}"

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
