#!/bin/bash

cd $(dirname $0)/../public/butterchurn-presets

dirs=$(find . -maxdepth 1 -mindepth 1 -type d ! -name "." | sed -e "s/.*\///"|sort)

(
    echo '['
    isFirst=1
    for d in $(echo $dirs); do 
        if [ $isFirst -eq 0 ]; then
            printf ',\n'
        fi
        printf '\t"%s"' "$d"
        ../../scripts/mkindex.sh $d
        isFirst=0
    done

    printf '\n]\n'
)>preset-groups.json

