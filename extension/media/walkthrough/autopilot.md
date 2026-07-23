# Watch Auto-Pilot do the rest

Once the engines are installed and an agent is picked, Auto-Pilot takes over:

1. **Scans the project** — builds the code map, writes a plain-language handbook, and lists every service.
2. **Sets up each service** — your agent works out the real start command and Vinv verifies it actually works.
3. **Runs everything with tracing on** — every call is recorded with timing, memory, and errors.
4. **Fixes what breaks** — failures go to your agent with the evidence attached, and Vinv re-checks the fix by running it.

It starts by itself after the first scan (you can turn that off in Configure). While it runs, the **Flow panel** in the Vinv sidebar pulses on the step it's working — nothing to click.

If Auto-Pilot hits something it can't fix, it tells you once, with a **Show in Flow** button that takes you straight to the problem.
