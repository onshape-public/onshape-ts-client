#!/bin/bash

npm run build

# This script does not validation and relies on having clexcorp creds.
# The idea is to simply ensure all the scripts runs without error by simply watching
# the terminal

EXPORT_DIR=${HOME}/testrun/export
REPORT_DIR=${HOME}/testrun/report
OUTPUT_DIR=${HOME}/testrun/output

npm run revisionexport -- --stack=clexcorp \
  --report-dir=$REPORT_DIR --export-dir=$EXPORT_DIR --output-dir=$OUTPUT_DIR \
  --days=2

npm run revisionexport -- --stack=clexcorp \
  --report-dir=$REPORT_DIR --export-dir=$EXPORT_DIR --output-dir=$OUTPUT_DIR \

npm run processfolder -- --stack=clexcorp --folder=417e12b081a7719da1d38d1b \
  --report-dir=$REPORT_DIR --export-dir=$EXPORT_DIR --output-dir=$OUTPUT_DIR \

npm run findrevisions  -- --stack=clexcorp

npm run findrevisions  -- --stack=clexcorp --all

npm run findworkflows  -- --stack=clexcorp --objectType=TASK


node ./.compiledjs/webhook.js --ngrok &

npm run createrevision -- --docuri='https://clexcorp.onshape.com/documents/749912839fc14e322c81d8b6/w/e0238ba0c7cea661fe254e26/e/5044ca3dc721c41196efd95a'

wait $(jobs -p)
