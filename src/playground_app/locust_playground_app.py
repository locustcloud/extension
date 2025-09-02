from __future__ import annotations
from flask import Flask, jsonify, request
import os, random, time

def create_app() -> Flask:
    app = Flask(__name__)

    # simple in-memory state for the tutorial
    state = {
        "products": [{"id": i, "name": f"Product {i}"} for i in range(1, 201)],
        "cart": [],  # per-process shared (fine for tutorial)
        "checkout_error_rate": float(os.getenv("CHECKOUT_ERROR_RATE", "0.02")),
    }

    def sleep_ms(ms: int = 25):
        time.sleep(ms / 1000.0)

    @app.get("/")
    def home():
        sleep_ms(20)
        return "OK", 200

    @app.post("/authenticate")
    def authenticate():
        sleep_ms(30)
        data = request.get_json(silent=True) or {}
        if data.get("user") and data.get("password"):
            return jsonify({"token": "fake-token"}), 200
        return jsonify({"error": "bad creds"}), 401

    @app.get("/products")
    def products():
        sleep_ms(50)
        return jsonify(state["products"]), 200

    @app.post("/cart/add")
    def cart_add():
        sleep_ms(40)
        data = request.get_json(silent=True) or {}
        pid = data.get("productId")
        if not pid:
            return jsonify({"error": "productId required"}), 400
        state["cart"].append(pid)
        return jsonify({"ok": True, "cartSize": len(state["cart"])}), 200

    @app.post("/checkout/confirm")
    def checkout():
        sleep_ms(60)
        if random.random() < state["checkout_error_rate"]:
            return jsonify({"error": "payment failed"}), 500
        # clear the cart on success
        order_id = random.randint(1000, 9999)
        state["cart"].clear()
        return jsonify({"orderId": order_id}), 200

    # optional tiny control endpoint to change behavior at runtime
    @app.post("/_control")
    def control():
        body = request.get_json(silent=True) or {}
        if "checkout_error_rate" in body:
            try:
                state["checkout_error_rate"] = float(body["checkout_error_rate"])
            except Exception:
                pass
        return jsonify({"ok": True, "state": state}), 200

    return app

def main():
    port = int(os.getenv("PORT", "5000"))
    app = create_app()
    app.run(host="0.0.0.0", port=port)


