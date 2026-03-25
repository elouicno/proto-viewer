#!/bin/bash
# ──────────────────────────────────────────────
# add-proto.sh — Ajouter un prototype HTML au viewer
# Usage: ./add-proto.sh mon-fichier.html "Nom affiché" "📊"
# ──────────────────────────────────────────────

FILE="$1"
NAME="$2"
ICON="${3:-📄}"

if [ -z "$FILE" ]; then
  echo "Usage: ./add-proto.sh <fichier.html> [\"Nom affiché\"] [\"emoji\"]"
  echo ""
  echo "Exemples:"
  echo "  ./add-proto.sh login.html"
  echo "  ./add-proto.sh dashboard.html \"Dashboard principal\" \"📊\""
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "Erreur: fichier '$FILE' introuvable"
  exit 1
fi

# Copy file to protos/ folder
BASENAME=$(basename "$FILE")
cp "$FILE" "protos/$BASENAME"

# Auto-detect name from <title> tag if not provided
if [ -z "$NAME" ]; then
  NAME=$(grep -oP '(?<=<title>).*?(?=</title>)' "$FILE" 2>/dev/null | head -1)
  if [ -z "$NAME" ]; then
    NAME="${BASENAME%.*}"
  fi
fi

# Add entry to prototypes.json using python (handles JSON properly)
python3 -c "
import json, sys
with open('prototypes.json', 'r') as f:
    data = json.load(f)
entry = {'name': '''$NAME''', 'file': 'protos/$BASENAME', 'icon': '$ICON'}
# Add to first category
if len(data) == 0:
    data.append({'category': 'Prototypes', 'items': []})
data[0]['items'].append(entry)
with open('prototypes.json', 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
print(f'✓ Ajouté: {entry[\"name\"]} → protos/$BASENAME')
"

echo ""
echo "Maintenant, faites:"
echo "  git add protos/$BASENAME prototypes.json"
echo "  git commit -m \"Add proto: $NAME\""
echo "  git push"
