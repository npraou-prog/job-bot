#!/usr/bin/env bash
# Launch Dice, RobertHalf, MatlenSilver, Randstad-DS, Kforce, and InsightGlobal bots in separate Terminal windows.
# Usage: ./run-bots.sh

DIR="$(cd "$(dirname "$0")" && pwd)"

osascript <<EOF
-- Dice bot window
tell application "Terminal"
    activate
    do script "cd '${DIR}/Dice' && node dice-bot.js"
end tell

-- RobertHalf bot window
tell application "Terminal"
    do script "cd '${DIR}/RobertHalf' && node roberthalf-bot.js"
end tell

-- MatlenSilver bot window
tell application "Terminal"
    do script "cd '${DIR}/MatlenSilver' && node matlensilver-bot.js"
end tell

-- Randstad-DS bot window
tell application "Terminal"
    do script "cd '${DIR}/Randstad-DS' && node randstad-ds-bot.js scrape"
end tell

-- Kforce bot window
tell application "Terminal"
    do script "cd '${DIR}/Kforce' && node kforce-bot.js"
end tell

-- InsightGlobal bot window
tell application "Terminal"
    do script "cd '${DIR}/InsightGlobal' && node insightglobal-bot.js 240"
end tell

-- Collabera bot window
tell application "Terminal"
    do script "cd '${DIR}/Collabera' && node collabera-bot.js 240"
end tell
EOF
