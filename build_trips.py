"""Build trips.json from ETS GTFS data.

Usage:
    python build_trips.py [--gtfs <url-or-zip-path>] > trips.json

Example:
    python build_trips.py --gtfs gtfs.zip > trips.json
"""

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
import zipfile

DEFAULT_GTFS_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip"


def normalize_stop_name(name):
    """
    Normalize GTFS stop names to match Arc CSV style.
    Example: "104 St NW & 82 Av NW" -> "104 Street & 82 Avenue"
    """
    if not name:
        return ""
    
    # Remove NW, SW, NE, SE suffixes
    name = re.sub(r"\b(NW|SW|NE|SE)\b", "", name, flags=re.IGNORECASE)
    
    # Normalize Stop/Station
    name = re.sub(r"\b(Stop|Station)\b", "", name, flags=re.IGNORECASE)
    
    # Expand Av/Ave to Avenue
    name = re.sub(r"\b(Av|Ave)\b", "Avenue", name, flags=re.IGNORECASE)
    
    # Expand St to Street, but try to avoid Saints
    saints = ["Albert", "Anne", "Vital", "Rose", "Joachim", "Jude", "Thomas", "James", "Joseph", "Charles", "George", "Paul", "Mary", "Churchill"]
    saints_re = "|".join(saints)
    name = re.sub(r"\bSt\b(?!\s+(" + saints_re + "))", "Street", name, flags=re.IGNORECASE)
    
    # Strip A/B/C suffixes from street/avenue numbers
    name = re.sub(r"\b(\d+)[a-z]\b", r"\1", name, flags=re.IGNORECASE)
    
    # Clean up extra spaces
    name = re.sub(r"\s+", " ", name).strip()
    
    # Ensure spacing around '&' is consistent
    name = re.sub(r"\s*&\s*", " & ", name)
    
    return name


def get_gtfs_file(path_or_url):
    if path_or_url.startswith("http"):
        print(f"Downloading GTFS from {path_or_url}...", file=sys.stderr)
        req = urllib.request.Request(
            path_or_url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        )
        with urllib.request.urlopen(req) as response:
            return io.BytesIO(response.read())
    else:
        return open(path_or_url, "rb")


def build_trips(gtfs_stream):
    with zipfile.ZipFile(gtfs_stream) as z:
        # 1. Load stops
        print("Loading stops...", file=sys.stderr)
        stops = {}
        with z.open("stops.txt") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for row in reader:
                stops[row["stop_id"]] = normalize_stop_name(row["stop_name"])

        # 2. Load routes
        print("Loading routes...", file=sys.stderr)
        routes = {}
        with z.open("routes.txt") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for row in reader:
                route_id = row["route_id"]
                short_name = row["route_short_name"]
                route_type = row.get("route_type", "3") # Default to bus (3)
                
                # Strip leading zeros for numeric-ish routes (e.g., "001" -> "1", "001A" -> "1A")
                # But keep it if it's just "0" (unlikely)
                short_name = re.sub(r"^0+", "", short_name) or "0"
                
                # Expand LRT names
                if route_type == "0": # Tram, Streetcar, Light rail
                    if short_name == "Capital":
                        short_name = "Capital Line"
                    elif short_name == "Metro":
                        short_name = "Metro Line"
                    elif short_name == "Valley":
                        short_name = "Valley Line"
                
                routes[route_id] = short_name

        # 3. Load trips
        print("Loading trips...", file=sys.stderr)
        trip_info = {}  # trip_id -> (route_short_name, headsign)
        with z.open("trips.txt") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for row in reader:
                route_id = row["route_id"]
                route_short_name = routes.get(route_id, "Unknown")
                headsign = row["trip_headsign"]
                
                # Strip redundant route number from headsign if it starts with it
                # Example: route_short_name="4", headsign="4 Capilano" -> "Capilano"
                if headsign.startswith(route_short_name + " "):
                    headsign = headsign[len(route_short_name):].strip()
                
                trip_info[row["trip_id"]] = (route_short_name, headsign)

        # 4. Load stop times and group by trip_id
        print("Loading stop times (this may take a moment)...", file=sys.stderr)
        trip_stop_sequences = {}  # trip_id -> [(sequence, stop_name), ...]
        with z.open("stop_times.txt") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for row in reader:
                trip_id = row["trip_id"]
                if trip_id in trip_info:
                    if trip_id not in trip_stop_sequences:
                        trip_stop_sequences[trip_id] = []
                    stop_name = stops.get(row["stop_id"], "Unknown")
                    trip_stop_sequences[trip_id].append((int(row["stop_sequence"]), stop_name))

        # 5. Group by (route_short_name, headsign) and find distinct sequences
        print("Grouping distinct sequences...", file=sys.stderr)
        distinct_trips = {}  # (route_short_name, headsign) -> set of tuple(stops)
        
        for trip_id, seq_list in trip_stop_sequences.items():
            # Sort by sequence
            seq_list.sort()
            stop_names = tuple(name for _, name in seq_list)
            
            key = trip_info[trip_id]
            if key not in distinct_trips:
                distinct_trips[key] = set()
            distinct_trips[key].add(stop_names)

        # 6. Format for JSON
        output = []
        for (route_no, direction), sequences in sorted(distinct_trips.items()):
            for stops_seq in sorted(sequences):
                output.append({
                    "route_no": route_no,
                    "dir": direction,
                    "stops": list(stops_seq)
                })

        return output


def main():
    parser = argparse.ArgumentParser(description="Build trips.json from ETS GTFS data.")
    parser.add_argument("--gtfs", default=DEFAULT_GTFS_URL, help="URL or path to GTFS zip file")
    args = parser.parse_args()

    try:
        gtfs_stream = get_gtfs_file(args.gtfs)
        trips_data = build_trips(gtfs_stream)
        json.dump(trips_data, sys.stdout, indent=2)
        print()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
