# Reolink Web

A mobile-friendly web viewer for Reolink security cameras. It's a static site with no backend, no dependencies and no tracking. Your phone talks straight to your cameras.

## Features

- Live grid of all your cameras, one column on a phone and more on larger screens
- Full-screen single camera view with pinch, double-tap and drag zoom
- Pan, tilt and zoom controls for PTZ cameras: hold to move, release to stop
- Works with multiple cameras and NVR channels
- Can be added to your home screen

## Setup

1. Enable HTTPS on each camera (Network > Advanced > Port Settings in the Reolink client).
2. Connect your phone to the same network as the cameras, or to your home network by VPN.
3. Open the site and add a camera with its IP address, username and password.
4. Open `https://<camera-ip>` once in the same browser and accept the certificate warning. Browsers won't load pictures from a camera until its self-signed certificate is accepted.
5. If Chrome asks for permission to access devices on your local network, allow it.

## How it works, and its limits

Reolink cameras don't send CORS headers, so a page hosted on another site can't read their API responses. This app uses what browsers still allow:

| Feature | How it works | Limit |
| --- | --- | --- |
| Live view | Repeatedly loads the camera's `Snap` image | Up to a few frames per second, with no audio |
| PTZ | Sends `PtzCtrl` commands without reading the reply | The app can only detect network failures |
| Playback, alerts, settings | Not available | These need to read API responses, which requires a local proxy |

Battery-powered Reolink cameras generally have no HTTP API, so they won't work here.

## Security

- Logins are stored only in this browser. They are sent only to the camera addresses you enter, over HTTPS.
- The Reolink API takes the login in the URL of each request. It's encrypted in transit, but it's visible to anyone with access to the unlocked device, for example through "Copy image address".
- Browser storage for GitHub Pages is shared by all project sites under the same `username.github.io` address, so only host code you trust under that account.
- Use a separate view-only camera account unless you need PTZ, and don't expose your cameras directly to the internet. Use a VPN for remote access.

## Development

There's no build step. Serve the folder with any static server and open it in a browser.
