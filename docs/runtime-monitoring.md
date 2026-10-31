# Optional runtime evidence in MCP

An operator can set EAGLEYE_MCP_MONITOR_PATH to an existing local monitor JSON
file. The authenticated system_overview tool then includes runtime_monitor;
the same evidence is included by fetch for system:overview. With no path,
the status is not_configured and no file is read.

The file must contain checked_at (a UTC/offset timestamp), issues (an array of
monitor issue codes), and metrics (an object). Only allowlisted numeric counts,
disk space, timestamps and fixed issue codes are returned. Raw state, file paths,
exception text, endpoints, model names and credentials are never returned. Callers
cannot supply a path through MCP. Symlinks and non-regular files are rejected,
and reads are capped at 64 KiB.

Evidence older than 90 minutes is stale; unreadable or invalid state is
unavailable. Neither is healthy. A cloud notifier should compare incident sets,
send on new actionable issues or recovery, retain delivery IDs to avoid duplicate
notifications, and alert when the expected local monitor stops refreshing.
No configured notifier or successful future delivery is implied by this reader.

This bridge is read-only. It does not fetch data, change production settings,
restart services, copy the database, or enable backups. Monitoring a disabled
snapshot policy never requires enabling a daily full database backup.
