import argparse
import base64
import gzip
import io
import os
import pathlib
import shutil
import sys
import tempfile

from locust_cloud.actions import delete
from locust_cloud.apisession import ApiSession
from locust_cloud.common import CWD
from locust_cloud.web_login import logout, web_login

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

from argparse import ArgumentTypeError
from collections import OrderedDict
from collections.abc import Callable, Generator, Iterable
from typing import IO, Any, cast
from zipfile import ZipFile

import configargparse


class LocustTomlConfigParser(configargparse.TomlConfigParser):
    def parse(self, stream: IO[str]) -> OrderedDict[str, Any]:
        try:
            config = tomllib.loads(stream.read())
        except Exception as e:
            raise configargparse.ConfigFileParserException(f"Couldn't parse TOML file: {e}")

        result: OrderedDict[str, Any] = OrderedDict()

        for section in self.sections:
            data = configargparse.get_toml_section(config, section)
            if data:
                for key, value in data.items():
                    if isinstance(value, list):
                        result[key] = value
                    elif value is not None:
                        result[key] = str(value)
                break

        return result


def pipe(value: Any, *functions: Callable) -> Any:
    for function in functions:
        value = function(value)

    return value


def valid_project_path(path: str | pathlib.Path) -> pathlib.Path:
    try:
        # Expand '~' and eliminate '..', '.', and symlinks
        p = pathlib.Path(path).expanduser().resolve(strict=True)

        return p.relative_to(CWD)
    except FileNotFoundError:
        raise ArgumentTypeError(f"{path!r} does not exist")
    except OSError as exc:  # Bad characters, too long, etc
        raise ArgumentTypeError(f"{path!r} is not a valid path: {exc}")
    except ValueError:
        raise ArgumentTypeError(f"{path!r} is not under current working directory: {CWD}")


def valid_extra_packages_path(file_path: str) -> pathlib.Path:
    p = pathlib.Path(file_path).resolve()

    if not p.exists():
        raise ArgumentTypeError(f"Path not found: {file_path}")
    if p.is_file() and not (p.suffix == ".whl" or p.suffixes == [".tar", ".gz"]):
        raise ArgumentTypeError(f"Invalid file suffix (must be '.whl' or '.tar.gz'): {file_path}")

    return p


def transfer_encode(file_name: str, stream: IO[bytes]) -> dict[str, str]:
    return {
        "filename": file_name,
        "data": pipe(
            stream.read(),
            gzip.compress,
            base64.b64encode,
            bytes.decode,
        ),
    }


def transfer_encoded_file(file_path: str) -> dict[str, str]:
    try:
        with open(file_path, "rb") as f:
            return transfer_encode(os.path.basename(file_path), f)
    except FileNotFoundError:
        raise ArgumentTypeError(f"File not found: {file_path}")


def expanded(paths: Iterable[pathlib.Path], skip_folders: list[str] = []) -> Generator[pathlib.Path, None, None]:
    for path in paths:
        path = pathlib.Path(path)

        if path.is_dir():
            for root, _, file_names in os.walk(path):
                if root.split("/")[-1] in skip_folders:
                    continue
                for file_name in file_names:
                    yield pathlib.Path(root) / file_name
        else:
            yield path


def zip_project_paths(paths: Iterable[pathlib.Path], to_file: str = "project"):
    buffer = io.BytesIO()
    skip_folders = ["__pycache__"]

    with ZipFile(buffer, "w") as zf:
        for path in set(expanded(paths, skip_folders=skip_folders)):
            zf.write(path)

    buffer.seek(0)
    return transfer_encode(f"{to_file}.zip", buffer)


def flat_transfer_encoded_args_files(paths: list[pathlib.Path], to_file: str | None) -> dict[str, str]:
    buffer = io.BytesIO()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = pathlib.Path(tmpdir)

        for src in paths:
            src_path = pathlib.Path(src)
            dest_path = tmp_path / src_path.name

            if src_path.is_file():
                shutil.copy(src_path, dest_path)
            elif src_path.is_dir():
                shutil.copytree(src_path, dest_path)
            else:
                print(f"Warning: {src} is not a valid file or directory")

        # Create the zip archive
        with ZipFile(buffer, "w") as zf:
            for item in tmp_path.iterdir():
                if item.is_file():
                    zf.write(item, arcname=item.name)
                elif item.is_dir():
                    for root, _, files in os.walk(item):
                        for file in files:
                            file_path = pathlib.Path(root) / file
                            arcname = file_path.relative_to(tmp_path)
                            zf.write(file_path, arcname)

    buffer.seek(0)
    return transfer_encode(f"{to_file}.zip", buffer)


class MergeToTransferEncodedZipFlat(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        paths = cast(list[pathlib.Path], values)
        value = flat_transfer_encoded_args_files(paths, option_string.lstrip("-"))
        setattr(namespace, self.dest, value)


class WebLogin(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        web_login()
        parser.exit()


class WebLogout(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        logout()
        parser.exit()


class StackTeardown(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        session = ApiSession(namespace.non_interactive)
        delete(session)
        parser.exit()


cloud_parser = configargparse.ArgumentParser(add_help=False)
cloud_parser.add_argument(
    "--login",
    nargs=0,
    action=WebLogin,
    help="Launch an interactive session to authenticate your user.\nOnce completed your credentials will be stored and automatically refreshed for quite a long time.\nOnce those expire you will be prompted to perform another login.",
)
cloud_parser.add_argument(
    "--logout",
    nargs=0,
    action=WebLogout,
    help="Removes the authentication credentials",
)
cloud_parser.add_argument(
    "--delete",
    nargs=0,
    action=StackTeardown,
    help="Delete a running cluster. Useful if locust-cloud was killed/disconnected or if there was an error.",
)
cloud_parser.add_argument(
    "--requirements",
    metavar="<filename>",
    type=transfer_encoded_file,
    help="Optional requirements.txt file that contains your external libraries.",
)
cloud_parser.add_argument(
    "--non-interactive",
    action="store_true",
    default=False,
    help="This can be set when, for example, running in a CI/CD environment to ensure no interactive steps while executing.\nRequires that LOCUSTCLOUD_USERNAME, LOCUSTCLOUD_PASSWORD and LOCUSTCLOUD_REGION environment variables are set.",
    env_var="LOCUSTCLOUD_NON_INTERACTIVE",
)
cloud_parser.add_argument(
    "--workers",
    metavar="<int>",
    type=int,
    help="Number of workers to use for the deployment. Defaults to number of users divided by 500, but the default may be customized for your account.",
    default=None,
)
cloud_parser.add_argument(
    "--image-tag",
    type=str,
    default=None,
    help=configargparse.SUPPRESS,  # overrides the locust-cloud docker image tag. for internal use
)
cloud_parser.add_argument(
    "--local-instance",
    action="store_true",
    default=False,
    help=configargparse.SUPPRESS,
    # for internal use. Assumes you've started locust/exporter with something like:
    # LOCUSTCLOUD_SESSION_ID=valid-session-id LOCUST_WEB_LOGIN=1 LOCUST_LOGLEVEL=DEBUG python -m bootstrap
)
cloud_parser.add_argument(
    "--extra-files",
    nargs="*",
    type=valid_project_path,
    help="A list of extra files or directories to upload. Space-separated, e.g. `--extra-files testdata.csv *.py my-directory/`.",
)
cloud_parser.add_argument(
    "--extra-packages",
    action=MergeToTransferEncodedZipFlat,
    nargs="*",
    type=valid_extra_packages_path,
    help="A list of extra packages to upload. Space-separated whl/tar.gz files or directory packages to be installed when running locust.",
)
cloud_parser.add_argument(
    "--testrun-tags",
    nargs="*",
    default=None,
    help="A list of tags that can be used to filter testruns.",
)

combined_cloud_parser = configargparse.ArgumentParser(
    parents=[cloud_parser],
    default_config_files=[
        "~/.cloud.conf",
        "cloud.conf",
    ],
    auto_env_var_prefix="LOCUSTCLOUD_",
    formatter_class=configargparse.RawTextHelpFormatter,
    config_file_parser_class=configargparse.CompositeConfigParser(
        [
            LocustTomlConfigParser(["tool.locust"]),
            configargparse.DefaultConfigFileParser,
        ]
    ),
    description="""Launches a distributed Locust runs on locust.cloud infrastructure.

Example: locust --cloud -f my_locustfile.py --users 1000 ...""",
    epilog="""Any parameters not listed here are forwarded to locust master unmodified, so go ahead and use things like --users, --host, --run-time, ...
Locust config can also be set using config file (~/.locust.conf, locust.conf, pyproject.toml, ~/.cloud.conf or cloud.conf).
Parameters specified on command line override env vars, which in turn override config files.""",
    add_config_file_help=False,
    add_env_var_help=False,
)
combined_cloud_parser.add_argument(
    "-u",
    "--users",
    type=int,
    default=1,
    help="Number of users to launch. This is the same as the regular Locust argument, but also affects how many workers to launch.",
    env_var="LOCUST_USERS",
)
combined_cloud_parser.add_argument(
    "--loglevel",
    "-L",
    type=str.upper,
    help="Set --loglevel DEBUG for extra info.",
    choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    default="INFO",
)


def add_locust_cloud_argparse(parser):
    cloud_group = parser.add_argument_group(
        "Locust Cloud",
        """Launches a distributed Locust run on locust.cloud infrastructure.

Example: locust --cloud -f my_locustfile.py --users 1000 ...""",
    )

    # This arguments is defined here because only makes sense when
    # running from locust core
    cloud_group.add_argument(
        "--cloud",
        action="store_true",
        help="Run Locust in cloud mode.",
    )

    for action in cloud_parser._actions:
        cloud_group._add_action(action)
