
---

# Locust Load Testing for VS Code

This extension helps you **scaffold, run, and manage [Locust](https://locust.io/) load tests** directly from VS Code.
It integrates with Python environments, provides templates, snippets, and an Explorer view for your scenarios.

---

## ✨ Features

* **Explorer tree view**: browse `locustfile.py` files, user classes, and tasks.
* **One-click runs**:

  * Run a locustfile in Web UI mode.
  * Run in headless mode.
  * Run specific tasks or tags.
* **Environment setup**:

  * Detects existing Locust installation.
  * Prompts to create a local `.venv` and install Locust (via `uv` or `venv+pip`).
* **Templates**: create a ready-to-use `locustfile.py` from extension templates.
* **Snippets**: insert `@task`, `FastHttpUser`, and tagged task boilerplates quickly.
* **Command Palette integration**: run everything via `F1 → Locust: ...`.

---

## 🚀 Getting Started

### 1. Install dependencies

Ensure you have Python 3.8+ installed. On Debian/Ubuntu:

```bash
sudo apt install python3 python3-venv
```

Optionally install [uv](https://docs.astral.sh/uv/) for faster environments:

```bash
pipx install uv
```

### 2. Install the extension

Search **"Locust Load Testing"** in the VS Code Marketplace, or install from a `.vsix` package.

### 3. Initialize environment

When you first open a folder, the extension will prompt to:

* Create a `.venv` (with `uv` or `python -m venv`)
* Install the `locust` package inside

You can re-run this anytime via:

```
F1 → Locust: Initialize (Install/Detect)
```

### 4. Create your first scenario

Run:

```
F1 → Locust: Create Simulation
```

Pick a template (e.g. `locustfile.py`), and it will be copied into your workspace.
Open it and customize tasks as needed.

### 5. Run Locust

* **Run with Web UI**:

  ```
  F1 → Locust: Run (Web UI)
  ```

  This opens `http://localhost:8089` in your browser.

* **Run headless**:

  ```
  F1 → Locust: Run (Headless)
  ```

* **Run by tag**:

  ```
  F1 → Locust: Run by Tag…
  ```

  Enter a tag like `checkout,auth` to filter tasks.

---

## ⚙️ Extension Settings

This extension contributes the following settings:

* `locust.path`: Path to the Locust CLI (default: `locust`).
* `locust.envFolder`: Name of the local Python environment folder (default: `.venv`).
* `locust.defaultHost`: Default host URL for your tests.
* `locust.autoSetup`: Whether to prompt for setup on activation (`prompt` | `always` | `never`).

---

## ⌨️ Snippets

* `loctask` → Insert a `@task` function with a request.
* `locuser` → Boilerplate `FastHttpUser` class with a simple GET task.
* `loctag` → Task with a `@tag` decorator for selective runs.

---

## 📝 Release Notes

### 0.0.1

* Initial release with tree view, templates, snippets, and environment setup flow.

---

