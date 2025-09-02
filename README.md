
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
  * Prompts to create a local `locust_env` and install Locust (via `uv` or `venv+pip`).
* **Templates**: create a ready-to-use `locustfile.py` from extension templates.
* **Snippets**: insert `@task`, `FastHttpUser`, and tagged task boilerplates quickly.
* **Command Palette integration**: run everything via `F1 → Locust: ...`.
* **Playground app**: optional Flask demo backend to practice against.

---

## 🚀 Quick Start Tutorial (Playground + Locust)

This is the fastest way to try the extension with a demo backend.

1. **Create environment & install Flask**

   ```bash
   uv venv locust_env
   uv pip install flask
  ```
  
2. **Run the playground API**

   ```bash
   uv run python -m playground_app.locust_playground_app
   ```

   This starts a fake e-commerce API at:
   👉 [http://localhost:5000](http://localhost:5000)

3. **Scaffold a Locust scenario**

   In VS Code:

   ```
   F1 → Locust: Create Simulation
   ```

   Pick `locustfile.py` template.
   It contains sample tasks against the `/`, `/authenticate`, `/cart/add`, and `/checkout/confirm` endpoints.

4. **Run Locust against the playground**

   * Web UI:

     ```
     F1 → Locust: Run (Web UI)
     ```

     Open [http://localhost:8089](http://localhost:8089) and start a test against `http://localhost:5000`.

   * Headless:

     ```
     F1 → Locust: Run (Headless)
     ```

   * By tag:

     ```
     F1 → Locust: Run by Tag…
     ```

---

## 🏗️ Architecture Overview

```text
┌─────────────────────┐
│   VS Code Extension │
│  (Locust UI & CLI)  │
└─────────┬───────────┘
          │ Commands (Run, Init, Create, Tags)
          ▼
┌─────────────────────┐
│  Python Environment │
│   (locust_env venv) │
│   Locust installed  │
└─────────┬───────────┘
          │ Locust HTTP load generation
          ▼
┌─────────────────────┐
│  Playground Flask   │
│     Demo App        │
│ (Simulated API)     │
└─────────────────────┘
```

---

## ⚙️ Extension Settings

* `locust.path`: Path to the Locust CLI (default: `locust`).
* `locust.envFolder`: Name of the local Python environment folder (default: `locust_env`).
* `locust.defaultHost`: Default host URL for your tests.
* `locust.autoSetup`: Whether to prompt for setup on activation (`prompt` | `always` | `never`).

---

## ⌨️ Snippets

* `loctask` → Insert a `@task` function with a request.
* `locuser` → Boilerplate `FastHttpUser` class with a simple GET task.
* `loctag` → Task with a `@tag` decorator for selective runs.

---

## 🧑‍💻 Development (For Contributors)

If you want to hack on the extension itself:

```bash
npm install
npm run watch
```

Then press **F5** in VS Code to launch a new Extension Development Host with Locust support.

---

## 📝 Release Notes

### 0.0.1

* Initial release with tree view, templates, snippets, and environment setup flow.
* Added playground Flask app for tutorial-style scenarios.
* Added Quick Start tutorial for end-to-end demo.


---

