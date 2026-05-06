# 🔱 Trishul SNMP Suite

**Modern SNMP Management Platform**

[![GitHub Stars](https://img.shields.io/github/stars/tosumitdhaka/trishul-snmp-suite?style=for-the-badge)](https://github.com/tosumitdhaka/trishul-snmp-suite/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/tosumitdhaka/trishul-snmp-suite?style=for-the-badge)](https://github.com/tosumitdhaka/trishul-snmp-suite/network)
[![GitHub Issues](https://img.shields.io/github/issues/tosumitdhaka/trishul-snmp-suite?style=for-the-badge)](https://github.com/tosumitdhaka/trishul-snmp-suite/issues)
[![License](https://img.shields.io/github/license/tosumitdhaka/trishul-snmp-suite?style=for-the-badge)](LICENSE)
[![GHCR](https://img.shields.io/badge/GHCR-Packages-blue?style=for-the-badge&logo=github)](https://github.com/tosumitdhaka?tab=packages&repo_name=trishul-snmp-suite)

A web-based SNMP toolkit for network engineers and administrators. Simulate SNMP agents, send/receive traps, walk devices with MIB resolution, browse MIB trees, and manage MIB files—all from a clean, intuitive interface.

**Replace 5+ SNMP tools with one modern platform**

---

![Trishul SNMP Suite Demo](./assets/trishul_snmp_demo.gif)

---

## ✨ Features

- 🖥️ **SNMP Simulator** - Run configurable SNMP agent with custom OID values
- 🚶 **Walk & Parse** - Execute SNMP walks with MIB resolution, export to JSON/CSV
- 📡 **Trap Manager** - Send/receive SNMP traps with real-time monitoring
- 📚 **MIB Manager** - Upload, validate, and reload MIBs with dependency detection plus trusted-source dependency fetch
- 🌳 **MIB Browser** - Interactive tree explorer with hierarchical OID navigation, search, filtering, and current-view JSON/CSV export
- 🔐 **Secure** - Session-based authentication with active WebSocket logout and timeout enforcement
- 🐳 **Containerized** - Docker deployment with amd64 and arm64 support
- 🌐 **Modern UI** - Clean, responsive interface built with Bootstrap 5
- 📊 **Export Data** - JSON/CSV export for walks and trap data
- 🔄 **Real-time** - Live trap receiver with instant OID resolution
- ⚡ **WebSocket Push** - Live status and stats updates via WS — zero polling
- 📊 **Activity Stats** - Dashboard counters for SNMP requests, traps, walks, MIB reloads — all real-time

---

## 🎯 What Trishul SNMP Suite Replaces

| Tool | Cost | Trishul SNMP Suite |
|------|------|--------------|
| **Net-SNMP CLI tools** | Free | ✅ Web UI with no command memorization |
| **snmpsim** | Free | ✅ Test SNMP agent responses with web interface |
| **iReasoning MIB Browser** | $500+ | ✅ Free MIB browser with tree navigation |
| **snmptrapd** | Free | ✅ Real-time trap receiver for testing |
| **Custom scripts** | Time | ✅ Built-in JSON/CSV export functionality |
| **Multiple scattered tools** | Complexity | ✅ One unified platform |

**Save $500+ and consolidate your SNMP workflow.**

---

## 🚀 Quick Start

### One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/tosumitdhaka/trishul-snmp-suite/main/install-trishul-snmp-suite.sh | bash
```

### Access

- **App UI:** http://localhost:8080
- **API docs:** http://localhost:8080/docs
- **Default login:** `admin` / `admin123`

⚠️ **Change password immediately in Settings!**

### Custom Ports

```bash
APP_PORT=3000 ./install-trishul-snmp-suite.sh up
```

### Test This Checkout Locally

```bash
./install-trishul-snmp-suite.sh up-local
```

This builds the merged single application image from the current repository and starts the same one-shot deployment flow locally.

Legacy compatibility still works:

```bash
FRONTEND_PORT=8980 BACKEND_PORT=8900 ./install-trishul-snmp.sh up-local
```

**[📖 Detailed Installation Guide →](docs/installation_guide.md)**

---

## 🧩 Component Overview

### 🖥️ SNMP Simulator (Server Mode)
Run a configurable SNMP agent on UDP 1061 with custom OID values. Perfect for testing SNMP clients without real hardware.

**Key features:**
- Custom OIDs with any value and type
- SNMPv1/v2c support
- Persistent configuration
- Web-based control

**Use case:** Simulate devices for NMS development and testing.

**[📖 Full Simulator Guide →](docs/snmp_simulator_guide.md)**

---

### 🚶 Walk & Parse (Client Mode)
Execute SNMP walks against any device with automatic MIB resolution and data export.

**Key features:**
- Automatic OID → name resolution
- Bulk operations (GETBULK)
- JSON/CSV export
- Walk history

**Use case:** Test SNMP agent responses, validate walk implementations.

**[📖 Full Walker Guide →](docs/walker_guide.md)**

---

### 📡 Trap Manager (Client + Server)
Send and receive SNMP traps with real-time monitoring and MIB-based trap browsing.

**Key features:**
- **Trap Sender (Client):** Send v1/v2c traps with custom varbinds
- **Trap Receiver (Server):** Real-time trap display on UDP 1162
- **Trap Library:** Browse 24+ available traps from loaded MIBs
- Auto-populate varbinds from library

**Use case:** Validate trap format/syntax for NMS development.

**[📖 Full Trap Manager Guide →](docs/trap_manager_guide.md)**

---

### 📚 MIB Manager
Upload, validate, and manage MIB files with automatic dependency resolution.

**Key features:**
- Drag-and-drop upload
- Syntax validation
- Dependency resolution
- Trap enumeration
- Statistics (objects, imports, traps)

**Use case:** Validate MIBs before deployment, centralized MIB library.

**[📖 Full MIB Manager Guide →](docs/mib_manager_guide.md)**

---

### 🌳 MIB Browser
Interactive tree explorer for navigating OID hierarchies and understanding MIB structures.

**Key features:**
- **Dual views:** By module or standard OID hierarchy
- **Real-time search:** Find OIDs by name, numeric OID, or description
- **Smart filtering:** By module and type (scalars, tables, notifications)
- **Tree navigation:** Expandable with configurable depth (1-5 levels)
- **Details panel:** Full metadata, descriptions, varbinds
- **Integration:** Jump to Walker/Trap Sender with pre-filled data
- **State persistence:** Remembers your position

**Use case:** Explore MIB structures, understand OID relationships, find traps.

**[📖 Full MIB Browser Guide →](docs/mib_browser_guide.md)**

---

### 🔐 Settings
Manage authentication and system preferences.

**Key features:**
- Credential management (username + password with strength indicator)
- Auto-start toggles and session timeout (persisted to `app_settings.json`)
- Export or reset activity stats
- System info (version, author, description)

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────┐
│            Web Browser (App Port 8080)          │
│ Dashboard │ Simulator │ Walker │ Traps │ MIB    │
└──────────────────────┬──────────────────────────┘
                       │ HTTP / WebSocket
                       │
        ┌──────────────▼─────────────────────────┐
        │      Trishul SNMP Suite Container      │
        │      FastAPI + Static UI + WebSocket   │
        │                                        │
        │  ┌──────────────────────────────────┐  │
        │  │  UI Runtime                      │  │
        │  │  • index.html                    │  │
        │  │  • module partials               │  │
        │  │  • CSS, JS, icons                │  │
        │  └──────────────────────────────────┘  │
        │                                        │
        │  ┌──────────────────────────────────┐  │
        │  │  API and Services                │  │
        │  │  • Simulator (UDP 1061)          │  │
        │  │  • Trap Receiver (UDP 1162)      │  │
        │  │  • Walker                        │  │
        │  │  • MIB service and browser       │  │
        │  └──────────────────────────────────┘  │
        │                                        │
        │  ┌──────────────────────────────────┐  │
        │  │  Persistent Data Volume          │  │
        │  │  • /app/backend/data             │  │
        │  └──────────────────────────────────┘  │
        └───────────────┬────────────────────────┘
                        │ SNMP (UDP)
                        │
        ┌───────────────┴───────────────┐
        │                               │
   ┌────▼─────┐                   ┌─────▼─────┐
   │  Test    │                   │   Test    │
   │ Devices  │                   │ Receivers │
   └──────────┘                   └───────────┘
```

**Stack:** Python 3.11 • FastAPI • pysnmp • pysmi • Bootstrap 5 • Docker

**[📖 Detailed Architecture →](docs/architecture_overview.md)**

---

## 🎯 Use Cases

### For NMS Development
- ✅ Send test traps to validate receiver format/syntax
- ✅ Receive test traps to validate sender implementation
- ✅ Simulate SNMP agents for client testing
- ✅ Test SNMP walk responses

### For MIB Management
- ✅ Validate MIB syntax and dependencies
- ✅ Explore MIB structures interactively
- ✅ Search OIDs across multiple MIBs
- ✅ Resolve OID names ↔ numeric OIDs

### For Integration Testing
- ✅ Test SNMP integrations without production devices
- ✅ Validate trap handling in dev environments
- ✅ Simulate device responses for QA
- ✅ Export walk data for automated testing

### For Learning & Training
- ✅ Understand SNMP protocol behavior
- ✅ Explore standard MIB structures
- ✅ Practice SNMP operations safely
- ✅ Learn OID hierarchies visually

**[📖 More Use Cases & Examples →](docs/index.md)**

---

## 👥 Best For

- 🔧 **Network engineers** testing devices and exploring MIB structures
- 🚀 **DevOps teams** testing SNMP integrations
- 📚 **Students** learning SNMP protocols and MIB hierarchies
- ✅ **QA teams** validating SNMP implementations
- 👥 **Small teams** needing trap monitoring and MIB browsing
- 🧪 **Developers** building SNMP-enabled applications

### ⚠️ Not For

- ❌ Production 24/7 monitoring (use Zabbix, PRTG, LibreNMS)
- ❌ Enterprise-scale NMS (use SolarWinds, Cisco Prime)
- ❌ High-availability monitoring (use dedicated monitoring platforms)

---

## 📚 Documentation

### Repo Docs
- 📋 [Changelog](docs/changelog.md) - Version history and release notes
- 🛠️ [Development Setup](docs/development_setup.md) - Docker-first workflow plus native backend iteration
- 🚀 [Release Process](docs/release_process.md) - Version bumps, changelog, image publishing, and verification
- 🧭 [GitHub Workflow](docs/github_workflow.md) - Tracker IDs, labels, milestones, and PR conventions
- 🗺️ [Roadmap](docs/roadmap.md) - Active delivery tracks and deferred scope
- 🧾 [Issue Tracker](docs/issue_tracker.md) - Stable IDs for bugs, gaps, improvements, and features

### User Guides
- 📘 [Docs Home](docs/index.md)
- 📖 [Installation Guide](docs/installation_guide.md)
- 🚀 [First Steps](docs/first_steps.md)
- ❓ [FAQ](docs/faq.md)
- 🖥️ [SNMP Simulator Guide](docs/snmp_simulator_guide.md)
- 🚶 [Walker Guide](docs/walker_guide.md)
- 📡 [Trap Manager Guide](docs/trap_manager_guide.md)
- 📚 [MIB Manager Guide](docs/mib_manager_guide.md)
- 🌳 [MIB Browser Guide](docs/mib_browser_guide.md)

### Technical Reference
- 🏗️ [Architecture Overview](docs/architecture_overview.md)
- 🔧 [API Reference](docs/api_reference.md)
- 🐛 [Troubleshooting](docs/troubleshooting.md)

---

## 📰 Featured Article

[![Dev.to Article](https://img.shields.io/badge/Dev.to-Read%20Article-0A0A0A?style=for-the-badge&logo=dev.to)](https://dev.to/tosumitdhaka/building-trishul-snmp-a-modern-web-based-snmp-toolkit-to-replace-500-commercial-tools-3d53)

### 📝 [Building Trishul-SNMP: A Modern Web-Based SNMP Toolkit](https://dev.to/tosumitdhaka/building-trishul-snmp-a-modern-web-based-snmp-toolkit-to-replace-500-commercial-tools-3d53)

This article was published before the `1.4.0` rename and still uses the previous project name.

**A technical deep dive into building a free, open-source alternative to $500 commercial tools.**

Read about:
- 🏗️ **Architecture decisions** - Why FastAPI, pysnmp, and a container-first deployment model
- 🔧 **Technical challenges** - MIB parsing, state persistence, performance optimization
- 💡 **Solutions implemented** - Caching strategies, lazy loading, image optimization
- 📊 **Lessons learned** - 8 months of development insights
- 🎯 **Results** - 150+ stars, 500+ pulls, 3 companies in production

---

## 🤝 Contributing

We welcome contributions! 🎉

[![Contributors](https://img.shields.io/github/contributors/tosumitdhaka/trishul-snmp-suite?style=for-the-badge)](https://github.com/tosumitdhaka/trishul-snmp-suite/graphs/contributors)

**Ways to contribute:**
- 🐛 [Report bugs](https://github.com/tosumitdhaka/trishul-snmp-suite/issues)
- 💡 [Suggest features](https://github.com/tosumitdhaka/trishul-snmp-suite/issues)
- 🔧 [Submit pull requests](https://github.com/tosumitdhaka/trishul-snmp-suite/pulls)
- 📝 [Improve documentation](.github/CONTRIBUTING.md)
- 🌍 Translate the interface
- 🎨 Improve UI/UX
- ⭐ [Star the repo](https://github.com/tosumitdhaka/trishul-snmp-suite)

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md), [docs/github_workflow.md](docs/github_workflow.md), [docs/issue_tracker.md](docs/issue_tracker.md), and [docs/development_setup.md](docs/development_setup.md) for details.

---

## 💶 Support This Project

Trishul SNMP Suite is **100% free and open-source** (MIT License).

**If it helps you:**
- ⭐ [Star the repo](https://github.com/tosumitdhaka/trishul-snmp-suite) - Helps others discover it
- 💰 [Sponsor on GitHub](https://github.com/sponsors/tosumitdhaka) - Support development
- ☕ [Buy me a coffee](https://buymeacoffee.com/tosumitdhaka) - One-time donation
- 🐦 [Share on Twitter](https://twitter.com/intent/tweet?text=Check%20out%20Trishul%20SNMP%20Suite) - Spread the word
- 📝 Write a blog post about your experience

[![GitHub Sponsors](https://img.shields.io/github/sponsors/tosumitdhaka?style=for-the-badge&logo=github)](https://github.com/sponsors/tosumitdhaka)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support-yellow?style=for-the-badge&logo=buy-me-a-coffee)](https://buymeacoffee.com/tosumitdhaka)

---

## 🚀 Roadmap

Planning now lives in [docs/roadmap.md](docs/roadmap.md). Itemized bugs, gaps, improvement scopes, and feature candidates live in [docs/issue_tracker.md](docs/issue_tracker.md).

**1.4.0 scope**
- Single-image runtime with FastAPI-served static UI
- Rename to `Trishul SNMP Suite` plus single-package GHCR publishing
- Installer and data migration from legacy split-container deployments

**Still deferred after 1.4.0**
- `FEAT-002` SNMPv3 support
- `FEAT-004` to `FEAT-006`


[Vote on features →](https://github.com/tosumitdhaka/trishul-snmp-suite/issues)

---

## 📊 Project Stats

![GitHub commit activity](https://img.shields.io/github/commit-activity/m/tosumitdhaka/trishul-snmp-suite?style=flat-square)
![GitHub last commit](https://img.shields.io/github/last-commit/tosumitdhaka/trishul-snmp-suite?style=flat-square)
![GitHub code size](https://img.shields.io/github/languages/code-size/tosumitdhaka/trishul-snmp-suite?style=flat-square)

---

### Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct](.github/CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.

### Recognition

All contributors are recognized in [docs/contributors.md](docs/contributors.md) and release notes! 🌟

---

## 📄 License

MIT License - See [LICENSE](LICENSE) file for details.

**Free forever. No hidden costs. No feature paywalls.**

---

## 📞 Community & Support

- 💬 [GitHub Discussions](https://github.com/tosumitdhaka/trishul-snmp-suite/discussions) - Ask questions, share ideas
- 🐛 [Issues](https://github.com/tosumitdhaka/trishul-snmp-suite/issues) - Report bugs, request features
- 📧 Email: [sumitdhaka@zohomail.in](mailto:sumitdhaka@zohomail.in)
- 💼 LinkedIn: [Sumit Dhaka](https://www.linkedin.com/in/sumit-dhaka-a5a796b3/)

---

## 🙏 Acknowledgments

Built with:
- [FastAPI](https://fastapi.tiangolo.com/) - Modern Python web framework
- [pysnmp](https://github.com/etingof/pysnmp) - SNMP library for Python
- [pysmi](https://github.com/etingof/pysmi) - MIB parser and compiler
- [Bootstrap 5](https://getbootstrap.com/) - UI framework
- [Font Awesome](https://fontawesome.com/) - Icons

---
## Star This Repo

If Trishul SNMP Suite helps you, leave a star. ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=tosumitdhaka/trishul-snmp-suite&type=Date)](https://star-history.com/#tosumitdhaka/trishul-snmp-suite&Date)

---

<div align="center">

**Made with 🔱 by [Sumit Dhaka](https://github.com/tosumitdhaka)**

*Trishul SNMP Suite - Modern SNMP Management Made Simple*

If this project helps you, please consider [⭐ starring it](https://github.com/tosumitdhaka/trishul-snmp-suite) and [💰 sponsoring](https://github.com/sponsors/tosumitdhaka)!

[![GitHub](https://img.shields.io/badge/GitHub-tosumitdhaka-181717?style=for-the-badge&logo=github)](https://github.com/tosumitdhaka)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-0077B5?style=for-the-badge&logo=linkedin)](https://www.linkedin.com/in/sumit-dhaka-a5a796b3/)

**[⬆ Back to Top](#-trishul-snmp-suite)**

</div>
