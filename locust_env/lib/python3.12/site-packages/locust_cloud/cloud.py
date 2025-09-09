import logging
import os
import pathlib
import time
import webbrowser
from argparse import ArgumentTypeError
from threading import Thread

import requests
from locust_cloud.actions import delete
from locust_cloud.apisession import ApiSession
from locust_cloud.args import (
    combined_cloud_parser,
    valid_project_path,
    zip_project_paths,
)
from locust_cloud.common import __version__
from locust_cloud.import_finder import get_imported_files
from locust_cloud.input_events import input_listener
from locust_cloud.websocket import SessionMismatchError, Websocket, WebsocketTimeout

logger = logging.getLogger(__name__)


def configure_logging(loglevel: str) -> None:
    format = (
        "[%(asctime)s] %(levelname)s: %(message)s"
        if loglevel == "INFO"
        else "[%(asctime)s] %(levelname)s/%(module)s: %(message)s"
    )
    logging.basicConfig(format=format, level=loglevel)
    # Restore log level for other libs. Yes, this can probably be done more nicely
    logging.getLogger("requests").setLevel(logging.INFO)
    logging.getLogger("urllib3").setLevel(logging.INFO)


def deprecated_main():
    import sys

    print("`locust-cloud` is deprecated; use `locust --cloud` instead.", file=sys.stderr)
    return 1


def main(locustfiles: list[str] | None = None):
    options, locust_options = combined_cloud_parser.parse_known_args()

    configure_logging(options.loglevel)

    if not locustfiles:
        logger.error("A locustfile is required to run a test.")
        return 1

    try:
        relative_locustfiles: list[pathlib.Path] = [valid_project_path(locustfile) for locustfile in locustfiles]
    except ArgumentTypeError as e:
        logger.error(e)
        return

    session = ApiSession(options.non_interactive)
    websocket = Websocket()

    auto_extra_files = set()
    for lf in relative_locustfiles:
        auto_extra_files.update(get_imported_files(lf))

    project_files = set(relative_locustfiles + (options.extra_files or []) + list(auto_extra_files))
    logger.debug(f"Project files: {', '.join([str(posix_path) for posix_path in project_files])}")

    project_data = zip_project_paths(project_files)

    try:
        logger.info(f"Deploying ({session.region}, locust-cloud {__version__})")
        locust_env_variables = [
            {"name": env_variable, "value": os.environ[env_variable]}
            for env_variable in os.environ
            if env_variable.startswith("LOCUST_")
            and env_variable
            not in [
                "LOCUST_USERS",
                "LOCUST_WEB_HOST_DISPLAY_NAME",
                "LOCUST_SKIP_MONKEY_PATCH",
                "LOCUST_CLOUD",
            ]
        ]

        locust_args = [
            {"name": "LOCUST_USERS", "value": str(options.users)},
            {"name": "LOCUST_FLAGS", "value": " ".join([option for option in locust_options if option != "--cloud"])},
            {"name": "LOCUSTCLOUD_DEPLOYER_URL", "value": session.api_url},
            *locust_env_variables,
        ]

        if options.testrun_tags:
            locust_args.append({"name": "LOCUSTCLOUD_TESTRUN_TAGS", "value": ",".join(options.testrun_tags)})

        payload = {
            "locust_args": locust_args,
            "project_data": project_data,
            "user_count": options.users,
        }

        if options.image_tag is not None:
            logger.log(
                logging.DEBUG if options.image_tag in ["master", "latest"] else logging.INFO,
                f"You have requested image tag {options.image_tag}",
            )
            payload["image_tag"] = options.image_tag

        if options.workers is not None:
            payload["worker_count"] = options.workers

        if options.requirements:
            payload["requirements"] = options.requirements

        if options.extra_packages:
            payload["extra_packages"] = options.extra_packages

        for attempt in range(1, 16):
            if options.local_instance:
                response = requests.Response()
                response.status_code = 200
                js = {
                    "log_ws_url": f"ws://localhost:1095{os.environ.get('LOCUST_WEB_BASE_PATH', '')}/socket-logs",
                    "session_id": "valid-session-id",
                }
                break
            try:
                response = session.post("/deploy", json=payload)
                js = response.json()

                if response.status_code != 202:
                    # 202 means the stack is currently terminating, so we retry
                    break

                if attempt == 1:
                    logger.info(js["message"])

                time.sleep(2)
            except requests.exceptions.RequestException as e:
                logger.error(f"Failed to deploy the load generators: {e}")
                return 1
        else:
            logger.error("Your Locust instance is still running, run locust --delete")
            return 1

        if response.status_code != 200:
            try:
                logger.error(f"{js['Message']} (HTTP {response.status_code}/{response.reason})")
            except Exception:
                logger.error(
                    f"HTTP {response.status_code}/{response.reason} - Response: {response.text} - URL: {response.request.url}"
                )
            return 1

        log_ws_url = js["log_ws_url"]
        session_id = js["session_id"]

        def open_ui():
            webbrowser.open_new_tab("https://auth.locust.cloud/load-test")

        Thread(target=input_listener({"\r": open_ui, "\n": open_ui}), daemon=True).start()

        # logger.debug(f"Session ID is {session_id}")

        logger.info("Waiting for load generators to be ready...")
        websocket.connect(
            log_ws_url,
            auth=session_id,
        )
        logger.debug(f"SocketIO transport type: {websocket.sio.transport()}")
        websocket.wait()

    except KeyboardInterrupt:
        logger.debug("Interrupted by user")
        if options.local_instance:
            os.system("pkill -TERM -f bootstrap")
        else:
            delete(session)
        try:
            websocket.wait(timeout=True)
        except (WebsocketTimeout, SessionMismatchError) as e:
            logger.error(str(e))
            return 1
    except WebsocketTimeout as e:
        logger.error(str(e))
        delete(session)
        return 1
    except SessionMismatchError as e:
        # In this case we do not trigger the teardown since the running instance is not ours
        logger.error(str(e))
        return 1
    except Exception as e:
        logger.exception(e)
        delete(session)
        return 1
    else:
        delete(session)
