import ast
import importlib.util
import logging
import site
from pathlib import Path

from locust_cloud.common import CWD

logger = logging.getLogger(__name__)

SITE_PACKAGES_PATHS = [Path(p) for p in [site.getusersitepackages(), *site.getsitepackages()]]


def imported_modules(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name
        if isinstance(node, ast.ImportFrom):
            if node.level:  # relative import
                continue
            if node.module:
                yield node.module


def get_imported_files(file_path: Path) -> set[Path]:
    """
    Get a list of path that are imported from the given python script
    They are returned as relative paths to CWD
    """
    paths_queue: list[Path] = [Path(file_path).resolve()]
    paths_seen: set[Path] = set()
    imports: set[Path] = set()

    while paths_queue:
        current = paths_queue.pop()
        if current in paths_seen:
            continue

        tree = ast.parse(current.read_text())
        for mod in imported_modules(tree):
            spec = importlib.util.find_spec(mod)
            if spec and spec.origin:
                p = Path(spec.origin).resolve()
                if (
                    p != current
                    and p.is_relative_to(CWD)
                    and all(parent not in SITE_PACKAGES_PATHS for parent in p.parents)
                    and all(parent not in imports for parent in p.parents)
                    and not "site-packages" in str(p)
                    and p.name not in ["built-in", "frozen"]
                ):
                    # add the whole package directory if __init__.py, else the file
                    if p.name == "__init__.py":
                        pkg_dir = p.parent
                        paths_queue.extend([p for p in pkg_dir.rglob("*.py") if p.is_file()])
                        imports.add(p.parent)
                    else:
                        paths_queue.append(p)
                        imports.add(p)
            else:
                pass  # logger.debug(f"Unable to find spec for module: {mod}")

    return set([i.relative_to(CWD) for i in imports])
