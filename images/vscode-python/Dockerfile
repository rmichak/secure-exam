FROM exam-desktop-base

USER root

# Install Python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# Install Firefox from Mozilla PPA (snap version doesn't work in containers)
RUN add-apt-repository -y ppa:mozillateam/ppa \
    && echo 'Package: *\nPin: release o=LP-PPA-mozillateam\nPin-Priority: 1001' > /etc/apt/preferences.d/mozilla-firefox \
    && apt-get update \
    && apt-get install -y firefox \
    && rm -rf /var/lib/apt/lists/*

# Install VS Code (architecture-aware)
RUN apt-get update && apt-get install -y wget gpg \
    && wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg \
    && install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg \
    && ARCH=$(dpkg --print-architecture) \
    && echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list \
    && apt-get update \
    && apt-get install -y code \
    && rm -rf /var/lib/apt/lists/* packages.microsoft.gpg

# Create workspace directory
RUN mkdir -p /home/student/workspace && chown student:student /home/student/workspace

# Create Desktop directory and VS Code shortcut
RUN mkdir -p /home/student/Desktop && chown student:student /home/student/Desktop

# Create VS Code desktop shortcut
RUN echo '[Desktop Entry]\n\
Version=1.0\n\
Type=Application\n\
Name=Visual Studio Code\n\
Comment=Code Editor\n\
Exec=/usr/bin/code --no-sandbox /home/student/workspace\n\
Icon=vscode\n\
Terminal=false\n\
Categories=Development;IDE;\n\
StartupNotify=true' > /home/student/Desktop/vscode.desktop \
    && chmod +x /home/student/Desktop/vscode.desktop \
    && chown student:student /home/student/Desktop/vscode.desktop

# Pre-install Python extension for VS Code (as student user)
USER student
RUN code --install-extension ms-python.python --force 2>/dev/null || true

# Create VS Code settings for Python
RUN mkdir -p /home/student/.config/Code/User \
    && echo '{\n\
    "python.defaultInterpreterPath": "/usr/bin/python3",\n\
    "editor.fontSize": 14,\n\
    "workbench.startupEditor": "none",\n\
    "telemetry.telemetryLevel": "off"\n\
}' > /home/student/.config/Code/User/settings.json

# Set Firefox as default browser
RUN mkdir -p /home/student/.config \
    && echo '[Default Applications]\n\
x-scheme-handler/http=firefox.desktop\n\
x-scheme-handler/https=firefox.desktop\n\
x-scheme-handler/about=firefox.desktop\n\
text/html=firefox.desktop\n\
application/xhtml+xml=firefox.desktop' > /home/student/.config/mimeapps.list

# Create Firefox desktop shortcut
RUN echo '[Desktop Entry]\n\
Version=1.0\n\
Type=Application\n\
Name=Firefox\n\
Comment=Web Browser\n\
Exec=/usr/bin/firefox %u\n\
Icon=firefox\n\
Terminal=false\n\
Categories=Network;WebBrowser;\n\
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;\n\
StartupNotify=true' > /home/student/Desktop/firefox.desktop \
    && chmod +x /home/student/Desktop/firefox.desktop

WORKDIR /home/student
