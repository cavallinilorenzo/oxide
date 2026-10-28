"""Synthetic full-screen application for the real-PTY browser regression."""
import os
import sys
import time

sys.stdout.write("\x1b[2J\x1b[H\x1b[3J\x1b[?1049h\x1b[2J")
sys.stdout.flush()
for frame in range(40):
    size = os.get_terminal_size()
    sys.stdout.write(
        "\x1b[HInteractive terminal\r\n\r\n"
        f"Viewport: {size.columns} columns, {size.lines} rows\r\n"
        f"Frame: {frame}\r\n\r\n"
        "Output is updating without resizing the terminal.\r\n"
    )
    sys.stdout.flush()
    time.sleep(0.1)
sys.stdout.write("\x1b[?1049l")
sys.stdout.flush()
