# openGym Video Sync - Chrome Web Store Listing

## 基本信息 (Basic Information)
- **Extension Name**: openGym video sync
- **Short Name**: openGym Sync
- **Version**: 1.0.0
- **Default Language**: English (en) / 支持中文 (zh-CN)
- **Category**: Productivity / Health & Fitness

## 简短描述 (Summary / Short Description - Max 132 chars)
Pause the follow-along workout video when you pause on phone/watch, and sync progress automatically.

## 详细描述 (Detailed Description)
openGym Video Sync connects your openGym iPhone app with your computer's Chrome browser, enabling bidirectional follow-along workout playback synchronization.

### Key Features:
1. **Bidirectional Pause & Resume**: When you pause your workout on your phone or Apple Watch, the corresponding video on your computer pauses immediately. When the video pauses, your workout timer pauses too.
2. **Timeline Synchronization**: Smart soft-sync keeps your workout and video timeline aligned without stuttering.
3. **Multi-Platform Support**: Seamlessly works with major workout video platforms including Bilibili, YouTube, and Vimeo.
4. **Zero-Configuration Pairing**: Quick 4-digit pairing code or local network auto-discovery. No cloud account or third-party server required.
5. **Privacy First**: All synchronization data flows strictly within your local network. No video history, account data, or personal information is tracked or uploaded to external servers.

### How to Use:
1. Install this extension in Chrome.
2. Open openGym on your iPhone (Settings > Video sync).
3. Connect with the 4-digit pairing code or automatic local network discovery.
4. Start your workout and open the exercise video. They will stay in sync automatically!

---

## 隐私权与权限声明 (Privacy & Permissions Justification)
- **storage**: Used to store the 4-character pairing code, paired phone LAN address, and sync preferences locally in Chrome.
- **cookies**: Used only when connecting to an authenticated self-hosted openGym instance to forward the user's own session cookie (`gymsid` / `__Host-gymsid`).
- **tabs & scripting**: Required to open or locate the matching workout video tab (Bilibili, YouTube, Vimeo), jump to the configured timestamp (`?t=`), and synchronize play/pause states.
- **alarms**: Used for periodic connection health checks, automatic LAN phone discovery, and automatic reconnection after service worker suspension.
- **host_permissions (`bilibili.com`, `youtube.com`, `vimeo.com`, `*:8787`)**: Strictly limited to controlling playback on supported workout video sites and communicating with the user's openGym iPhone LAN server on port `8787`. No personal or browsing data is harvested or sent to any third party.
- **optional_host_permissions (`http://*/*`, `https://*/*`)**: Requested only when the user manually configures a custom port or self-hosted server URL in Advanced settings.
- **Single Purpose**: This extension exists solely to synchronize follow-along workout video playback between the openGym mobile app and Chrome browser.
