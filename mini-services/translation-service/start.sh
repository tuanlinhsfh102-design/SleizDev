#!/bin/bash
# Start translation service and keep it running
cd /home/z/my-project/mini-services/translation-service

LOG=/home/z/my-project/.zscripts/mini-service-translation-service.log

while true; do
  echo "[$(date)] Starting translation-service..." >> $LOG
  bun src/index.ts >> $LOG 2>&1
  EXIT_CODE=$?
  echo "[$(date)] translation-service exited with code $EXIT_CODE, restarting in 3s..." >> $LOG
  sleep 3
done
