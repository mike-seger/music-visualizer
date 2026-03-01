#!/bin/bash

function usage() {
	echo "$1"
	echo "Usage: $0 <metafile> <target directory>"
}

scriptdir=$(dirname "$0")
metafile="$1"
target="$2"
presetdir=$(echo "$target" |sed -E "s|/$||;s|/[^/]+$||")
echo "$presetdir"

src=$(dirname "$metafile")

if [ ! -f "$metafile" ]; then
        usage "The metafile '$metafile' doesn't exist"
        exit 1
fi

if [[ -z "$src" || ! -d "$src" ]]; then
	usage "Source directory '$src' must not exist"
	exit 1
fi

if [[ -z "target" || -d "$target" || -f "$target" ]]; then
	usage "Target directory '$target' must not exist"
	exit 1
fi

mkdir "$target" || usage "Unable to create '$target'"
mkdir "$target/presets-src" || usage "Unable to create '$target/presets-src'"
cp -a "$src/"* "$target"

i=1
cat "$metafile" | grep ":" | grep -Ev '("type"|"imageExt"|"srcMap")' | sed -e 's/.*": "//;s/",*$//;' | while read f; do 
	f2=$(find "$presetdir/" -name "$f" -type f| head -1) 
	if [ "$?"  -ne 0 ]; then 
		echo "Cannot find $f"
		break
	fi
	
	if [ ! -f "$f2" ] ; then
		echo "$i: Not found: $f" 
	else
		echo "$i: $f"
	fi	
	cp "$f2" "$target/presets-src/"
	i=$((i+1))
done 

"$scriptdir/mkmeta.sh" "$target"