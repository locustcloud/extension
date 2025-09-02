from datetime import datetime, timedelta
import os
import json
import time
import uuid
import random

import paho.mqtt.client as mqtt
import locust

# ── Config
BROKER = os.getenv("MQTT_BROKER", "localhost")
PORT = int(os.getenv("MQTT_PORT", 1883))
TOPIC_TEMPLATE = os.getenv("MQTT_TOPIC_TEMPLATE", "client/{client_id}/session/{session_id}/")
SESSION_HOURS = float(os.getenv("SESSION_HOURS", "26"))
POINT_INTERVAL_MIN = int(os.getenv("POINT_INTERVAL_MIN", "2"))
SEND_INTERVAL_SECONDS = float(os.getenv("SEND_INTERVAL_SECONDS", "1.5"))

TRANSIT_ACTIVITIES = ["walking", "cycling", "driving", "public_transport"]

def generate_client_id():
    return f"usr{random.randint(1, 53)}-{uuid.uuid4()}"

def generate_session_id():
    return random.randint(1000, 9999)

def realistic_speed(activity):
    if activity == "walking": return round(random.uniform(1, 5), 2)
    if activity == "cycling": return round(random.uniform(8, 25), 2)
    if activity == "driving": return round(random.uniform(30, 120), 2)
    if activity == "public_transport": return round(random.uniform(20, 80), 2)
    return 1.0

def generate_pois_for_client(client_id, seed_offset=0):
    random.seed(f"{client_id}_{seed_offset}")
    base_lat = 59.3 + random.uniform(-0.05, 0.05)
    base_lon = 18.0 + random.uniform(-0.05, 0.05)
    return [
        (base_lat, base_lon),
        (base_lat + 0.01, base_lon + 0.02),
        (base_lat + 0.02, base_lon - 0.01),
        (base_lat - 0.01, base_lon + 0.03),
    ]

def leg_points(start, end, start_time, duration_min, per_point_min):
    activity = random.choice(TRANSIT_ACTIVITIES)
    steps = max(duration_min // per_point_min, 1)
    lat_step = (end[0] - start[0]) / steps
    lon_step = (end[1] - start[1]) / steps
    lat, lon = start
    t = start_time
    for _ in range(steps):
        yield {
            "lat": lat,
            "lon": lon,
            "elevation": round(random.uniform(0, 50), 2),
            "speed": realistic_speed(activity),
            "activity": activity,
            "timestamp": t.isoformat(),
        }
        lat += lat_step
        lon += lon_step
        t += timedelta(minutes=per_point_min)

def generate_stream(client_id, session_start, per_point_min):
    pois = generate_pois_for_client(client_id)
    clock = session_start
    i = 0
    while True:
        start = pois[i % len(pois)]
        end = pois[(i + 1) % len(pois)]
        commute = random.randint(8, 45)
        for p in leg_points(start, end, clock, commute, per_point_min):
            yield p
        clock += timedelta(minutes=commute + random.choice([15, 30, 45, 60, 90, 120]))
        i += 1

class MqttStreamingUser(locust.User):
    wait_time = locust.constant(SEND_INTERVAL_SECONDS)

    def on_start(self):
        self.client_id = generate_client_id()
        self.session_id = generate_session_id()
        self.session_end = datetime.utcnow()
        self.session_start = self.session_end - timedelta(hours=SESSION_HOURS)
        self.start_iso = self.session_start.isoformat()
        self.end_iso = self.session_end.isoformat()
        self.topic = TOPIC_TEMPLATE.format(client_id=self.client_id, session_id=self.session_id)
        self.stream = generate_stream(self.client_id, self.session_start, POINT_INTERVAL_MIN)

        self.mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=self.client_id, clean_session=False)
        self.mqtt_client.user_data_set({"client_id": self.client_id})
        self.mqtt_client.connect(BROKER, PORT, keepalive=300)
        self.mqtt_client.loop_start()

    @locust.task
    def send_point(self):
        point = next(self.stream)
        payload = {
            "client_id": self.client_id,
            "session_id": self.session_id,
            "start_time": self.start_iso,
            "end_time": self.end_iso,
            "trajectory": [point]
        }
        self.mqtt_client.publish(self.topic, json.dumps(payload), qos=1)

    def on_stop(self):
        self.mqtt_client.loop_stop()
        self.mqtt_client.disconnect()
