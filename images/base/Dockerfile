FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV USER=student
ENV HOME=/home/student

# Install desktop environment and VNC
RUN apt-get update && apt-get install -y \
    xfce4 \
    xfce4-terminal \
    tigervnc-standalone-server \
    tigervnc-common \
    novnc \
    websockify \
    dbus-x11 \
    sudo \
    imagemagick \
    fonts-dejavu \
    zenity \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Install website filtering dependencies
RUN apt-get update && apt-get install -y \
    squid-openssl \
    dnsmasq \
    iptables \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create filtering directories
RUN mkdir -p /etc/squid/errors \
    && mkdir -p /etc/squid/ssl \
    && mkdir -p /etc/dnsmasq.d \
    && mkdir -p /var/lib/squid/ssl_db \
    && mkdir -p /var/spool/squid \
    && mkdir -p /var/log/squid

# Copy filtering configuration files
COPY filtering/squid.conf /etc/squid/squid.conf
COPY filtering/dnsmasq.conf /etc/dnsmasq.conf
COPY filtering/allowlist.txt /etc/squid/allowlist.txt
COPY filtering/block-page.html /etc/squid/errors/ERR_BLOCKED_SITE
COPY filtering/generate-dnsmasq.sh /usr/local/bin/generate-dnsmasq.sh
COPY filtering/setup-filtering.sh /usr/local/bin/setup-filtering.sh

# Set proper permissions on all config files and scripts
RUN chmod 644 /etc/dnsmasq.conf \
    && chmod 644 /etc/squid/squid.conf \
    && chmod 644 /etc/squid/allowlist.txt \
    && chmod 644 /etc/squid/errors/ERR_BLOCKED_SITE \
    && chmod 755 /usr/local/bin/generate-dnsmasq.sh \
    && chmod 755 /usr/local/bin/setup-filtering.sh \
    && /usr/local/bin/generate-dnsmasq.sh \
    && chmod 644 /etc/dnsmasq.d/allowlist.conf

# Set proper permissions for Squid
RUN chown -R proxy:proxy /var/log/squid \
    && chown -R proxy:proxy /var/spool/squid \
    && chown -R proxy:proxy /var/lib/squid \
    && chown -R proxy:proxy /etc/squid/ssl

# Create non-root user
RUN useradd -m -s /bin/bash $USER \
    && echo "$USER:$USER" | chpasswd \
    && adduser $USER sudo

# Set up VNC
RUN mkdir -p $HOME/.vnc \
    && echo "student" | vncpasswd -f > $HOME/.vnc/passwd \
    && chmod 600 $HOME/.vnc/passwd \
    && chown -R $USER:$USER $HOME/.vnc

# VNC startup script
COPY startup.sh /startup.sh
RUN chmod 755 /startup.sh

# Submit assignment script
COPY submit.sh /usr/local/bin/submit
RUN chmod 755 /usr/local/bin/submit

# Create desktop shortcut for submit
RUN mkdir -p $HOME/Desktop \
    && echo '[Desktop Entry]\n\
Type=Application\n\
Name=Submit Assignment\n\
Comment=Submit your completed assignment\n\
Exec=/usr/local/bin/submit\n\
Icon=document-send\n\
Terminal=false\n\
Categories=Education;' > $HOME/Desktop/submit.desktop \
    && chmod 755 $HOME/Desktop/submit.desktop \
    && chown -R $USER:$USER $HOME/Desktop

EXPOSE 5901 6080

# Note: We start as root for filtering setup, startup.sh handles user switching
WORKDIR $HOME

CMD ["/startup.sh"]
