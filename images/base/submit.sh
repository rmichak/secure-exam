#!/bin/bash
# Submit Assignment Script
# Creates a zip of the selected assignment and saves to submissions folder

WORKSPACE="$HOME/workspace"
ASSIGNMENTS_DIR="$WORKSPACE/assignments"
SUBMISSIONS_DIR="$WORKSPACE/submissions"

# Ensure submissions directory exists
mkdir -p "$SUBMISSIONS_DIR"

# Check if assignments directory exists
if [ ! -d "$ASSIGNMENTS_DIR" ]; then
    zenity --error --title="No Assignments" --text="No assignments folder found.\nPlease contact your instructor."
    exit 1
fi

# Get list of assignments
ASSIGNMENTS=$(ls -1 "$ASSIGNMENTS_DIR" 2>/dev/null)
if [ -z "$ASSIGNMENTS" ]; then
    zenity --error --title="No Assignments" --text="No assignments found in your workspace."
    exit 1
fi

# Build zenity list options
OPTIONS=""
for dir in $ASSIGNMENTS; do
    if [ -d "$ASSIGNMENTS_DIR/$dir" ]; then
        OPTIONS="$OPTIONS FALSE $dir"
    fi
done

# Show selection dialog
SELECTED=$(zenity --list \
    --title="Submit Assignment" \
    --text="Select the assignment to submit:" \
    --radiolist \
    --column="Select" \
    --column="Assignment" \
    --width=400 \
    --height=300 \
    $OPTIONS)

# Check if user cancelled
if [ -z "$SELECTED" ]; then
    exit 0
fi

# Confirm submission
zenity --question \
    --title="Confirm Submission" \
    --text="Submit '$SELECTED'?\n\nThis will create a zip file of your work." \
    --width=300

if [ $? -ne 0 ]; then
    exit 0
fi

# Create timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ZIP_NAME="${SELECTED}_${TIMESTAMP}.zip"
ZIP_PATH="$SUBMISSIONS_DIR/$ZIP_NAME"

# Create the zip file
cd "$ASSIGNMENTS_DIR"
zip -r "$ZIP_PATH" "$SELECTED" -x "*.pyc" -x "__pycache__/*" -x ".git/*" -x "*.o" -x "*.class"

if [ $? -eq 0 ]; then
    # Calculate file size
    SIZE=$(ls -lh "$ZIP_PATH" | awk '{print $5}')

    zenity --info \
        --title="Submission Complete" \
        --text="Assignment '$SELECTED' submitted successfully!\n\nFile: $ZIP_NAME\nSize: $SIZE\n\nYour instructor can now see your submission." \
        --width=400
else
    zenity --error \
        --title="Submission Failed" \
        --text="Failed to create submission.\nPlease try again or contact your instructor."
fi
