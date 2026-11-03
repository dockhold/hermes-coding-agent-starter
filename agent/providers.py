"""Lists the model providers this Hermes release can use with an API key.

Runs once, at image build time, and prints JSON that the program reads at
start: for each provider its name, aliases and the environment variable
Hermes reads its key from. Providers that sign in through a browser or a
cloud SDK are left out: an unattended app cannot sign in.
"""

import json
import sys

from providers import list_providers


def main() -> int:
    out = {}
    for profile in list_providers():
        if profile.auth_type != "api_key" or not profile.env_vars:
            continue
        out[profile.name] = {
            "aliases": sorted(a for a in profile.aliases if isinstance(a, str)),
            "env": profile.env_vars[0],
        }
    if not out:
        print("no API-key providers found in this Hermes release", file=sys.stderr)
        return 1
    json.dump(dict(sorted(out.items())), sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
