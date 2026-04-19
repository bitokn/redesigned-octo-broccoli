"""Build trips.json from a directory of Transit55 HTML files plus the hardcoded LRT lines.

Usage:
    python build_trips.py /path/to/html_routes/ > trips.json
"""

import glob
import json
import os
import sys
from bs4 import BeautifulSoup


CAPITAL_STOPS = [
    "Century Park Station",
    "Southgate Station",
    "South Campus Ft Edmonton Station",
    "Health Sciences Jubilee Station",
    "University Station",
    "Government Station",
    "Corona Station",
    "Bay Enterprise Square Station",
    "Central Station",
    "Churchill Station",
    "Stadium Station",
    "Belvedere Station",
    "Clareview Station",
]

METRO_STOPS = [
    "Health Sciences Jubilee Station",
    "University Station",
    "Government Station",
    "Corona Station",
    "Bay Enterprise Square Station",
    "Central Station",
    "Churchill Station",
    "MacEwan Station",
    "Kingsway RAH Station",
    "NAIT Blatchford Market Station",
]

VALLEY_STOPS = [
    "102 Street Stop",
    "Churchill Station",
    "Quarters Stop",
    "Strathearn Stop",
    "Holyrood Stop",
    "Bonnie Doon Stop",
    "Davies Station",
    "Mill Woods Stop",
]

LRT_TRIPS = [
    ("Capital Line", "Clareview", CAPITAL_STOPS),
    ("Capital Line", "Century Park", list(reversed(CAPITAL_STOPS))),
    ("Metro Line", "NAIT", METRO_STOPS),
    ("Metro Line", "Health Sciences", list(reversed(METRO_STOPS))),
    ("Valley Line", "Mill Woods", VALLEY_STOPS),
    ("Valley Line", "102 Street", list(reversed(VALLEY_STOPS))),
]


def parse_trip_html(path):
    with open(path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f.read(), "html.parser")
    rows = soup.find("table").find("tbody").find_all("tr")
    stops = [r.find_all("td")[1].get_text(strip=True) for r in rows]
    label = soup.find("div", class_="ui basic big label").get_text(strip=True)
    parts = label.split(maxsplit=1)
    route_no = parts[0]
    direction = parts[1] if len(parts) > 1 else "Unknown"
    return {"route_no": route_no, "dir": direction, "stops": stops}


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    html_dir = sys.argv[1]
    trips = []

    for path in sorted(glob.glob(os.path.join(html_dir, "*.html"))):
        try:
            trips.append(parse_trip_html(path))
        except Exception as e:
            print(f"warn: skipping {path}: {e}", file=sys.stderr)

    for route_no, direction, stops in LRT_TRIPS:
        trips.append({"route_no": route_no, "dir": direction, "stops": stops})

    json.dump(trips, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
