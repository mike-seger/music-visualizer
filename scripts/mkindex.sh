#!/usr/bin/env bash

function usage() {
	echo "$@"
	echo "Usage: $0 <directory>"
}

function countEntries() {
    cat $1 | jq 'length'
}

[[ -z "$1" || ! -d "$1" ]] && usage && exit 1

index_file="$1/index.json"

# Skip if index.json exists and is newer than all other files in the directory
if [[ -f "$index_file" ]]; then
    newest=$(find "$1" -maxdepth 1 -type f ! -name index.json -newer "$index_file" -print -quit)
    if [[ -z "$newest" && $(ls "$1"/* | grep -v index.json| wc -l) -eq  $(countEntries $index_file) ]]; then
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

    for file in "$1"/*; do
        # Skip directories and index.json
        [[ -d "$file" ]] && continue
        file="${file##*/}"  # basename
        [[ "$file" == "index.json" ]] && continue

        # Get the filename without extension
        name="${file%.*}"
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

