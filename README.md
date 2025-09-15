
---

# Locust Load Testing for VS Code

This extension helps you **scaffold, run, and manage [Locust](https://locust.io/) load tests** directly from VS Code.  
It integrates with Python environments, provides templates, snippets, copilot chat and Explorer view for your Load Test Locustfiles.

---

## Features

* **Explorer tree view**: browse `templates/` py files, user classes, and tasks.
* **One-click runs**:
  * Run a in Web UI mode.
  * Run in headless mode.
  * Run specific tasks or tags.
* **Environment setup**:
  * Detects existing Locust installation.
  * Prompts to create a local `.locust_env` and install dependencies.
* **Templates**: create a ready-to-use `locustfile.py` from HAR files.
* **Snippets**: insert `@task`, `FastHttpUser`, and tagged task boilerplates quickly.
* **Command Palette integration**: Headless and UI test `F1 → Locust: ...`.
* **Test Server**: Larrys Giftshop.

---

## Installation

Open VS Code.

Go to the Extensions Marketplace.

Search for Locust Load Testing.

Click Install.

After installation the extension is available immediately.

---

Walkthrough

The walkthrough guides you through the key steps of running a Locust test directly inside VS Code.

Open or create a locustfile

Open a workspace that contains a locustfile.py.

Or run F1 → Locust: Create Simulation to scaffold a new one from a template.

Browse scenarios in the Explorer

Use the Locust Scenarios tree view to see available files, user classes, and tasks.

Run Locust from VS Code

Run in Web UI mode with F1 → Locust: Run (Web UI).

Run in Headless mode with F1 → Locust: Run (Headless).

Run by tags with F1 → Locust: Run by Tag.

View results

In Web UI mode open http://localhost:8089


[Copilot Workflow Example][def: media/08-copilot.md]

---

