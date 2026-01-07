#!/bin/bash

# ============================================================
# Step 1: Setup website filtering (requires root)
# ============================================================
if [ -f /usr/local/bin/setup-filtering.sh ]; then
    echo "[Startup] Initializing website filtering..."
    chmod +x /usr/local/bin/setup-filtering.sh /usr/local/bin/generate-dnsmasq.sh 2>/dev/null || true
    /usr/local/bin/setup-filtering.sh || echo "[Startup] Warning: Filtering setup had errors"
    echo "[Startup] Website filtering initialized."
fi

# ============================================================
# Step 2: Setup desktop environment for student user
# ============================================================
export USER=student
export HOME=/home/student

# Generate wallpaper with session info
SESSION_NAME="${SESSION_NAME:-Exam Desktop}"
STUDENT_NAME="${STUDENT_NAME:-Student}"
STUDENT_EMAIL="${STUDENT_EMAIL:-}"
COURSE_NAME="${COURSE_NAME:-Course}"
EXAM_MODE="${EXAM_MODE:-false}"
WALLPAPER="$HOME/wallpaper.png"

# Determine mode label and colors
if [ "$EXAM_MODE" = "true" ]; then
    MODE_LABEL="EXAM MODE"
    MODE_COLOR="#ff4444"
    BG_COLOR="#2a1a1a"
else
    MODE_LABEL="Lab Environment"
    MODE_COLOR="#00d4ff"
    BG_COLOR="#1a1a2e"
fi

# Create base wallpaper
convert -size 1920x1080 xc:"$BG_COLOR" "$WALLPAPER"

# Create info card overlay in top-right corner
INFO_CARD="/tmp/info_card.png"
convert -size 380x160 xc:'#000000' \
    -fill '#222233' -draw "roundrectangle 0,0 379,159 10,10" \
    -stroke '#444466' -strokewidth 1 -fill none -draw "roundrectangle 0,0 379,159 10,10" \
    "$INFO_CARD"

# Add text to info card
convert "$INFO_CARD" \
    -font DejaVu-Sans-Bold -pointsize 14 -fill "$MODE_COLOR" \
    -gravity northwest -annotate +15+12 "$MODE_LABEL" \
    -font DejaVu-Sans-Bold -pointsize 18 -fill '#ffffff' \
    -gravity northwest -annotate +15+35 "$STUDENT_NAME" \
    -font DejaVu-Sans -pointsize 12 -fill '#aaaaaa' \
    -gravity northwest -annotate +15+60 "$STUDENT_EMAIL" \
    -font DejaVu-Sans -pointsize 12 -fill '#888888' \
    -gravity northwest -annotate +15+85 "Course: $COURSE_NAME" \
    -font DejaVu-Sans -pointsize 10 -fill '#666666' \
    -gravity northwest -annotate +15+110 "Container: $SESSION_NAME" \
    "$INFO_CARD"

# Add center branding
convert "$WALLPAPER" \
    -font DejaVu-Sans-Bold -pointsize 48 -fill "$MODE_COLOR" \
    -gravity center -annotate +0-50 "$COURSE_NAME" \
    -font DejaVu-Sans -pointsize 20 -fill '#555555' \
    -gravity center -annotate +0+20 "$MODE_LABEL" \
    "$WALLPAPER"

# Composite info card onto wallpaper (top-right, with padding)
convert "$WALLPAPER" "$INFO_CARD" -gravity northeast -geometry +20+60 -composite "$WALLPAPER"

# Cleanup
rm -f "$INFO_CARD"

# Configure XFCE to use this wallpaper
mkdir -p "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
cat > "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitor0" type="empty">
        <property name="workspace0" type="empty">
          <property name="image-style" type="int" value="5"/>
          <property name="last-image" type="string" value="$WALLPAPER"/>
        </property>
      </property>
      <property name="monitorVNC-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="image-style" type="int" value="5"/>
          <property name="last-image" type="string" value="$WALLPAPER"/>
        </property>
      </property>
    </property>
  </property>
</channel>
EOF

# Ensure student owns their home directory files
chown -R $USER:$USER $HOME 2>/dev/null || true

# ============================================================
# Step 3: Start VNC server as student user
# ============================================================
echo "[Startup] Starting VNC server..."
sudo -u $USER vncserver :1 -geometry 1920x1080 -depth 24 -localhost no

# Start noVNC (websockify serves the noVNC web interface)
websockify --web=/usr/share/novnc/ 6080 localhost:5901 &

# Keep container running
tail -f /dev/null
