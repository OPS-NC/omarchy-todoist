// Pure data helpers for the Todoist panel: response shaping, sorting, and
// error-message translation. No QML/Qt types here so this stays testable on
// its own — the panel owns everything stateful (curl processes, settings
// file, UI).

function safeTrim(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

// Todoist filter query (e.g. "today | overdue"). Falls back to the default
// due/overdue view whenever the user clears the field.
function sanitizeFilter(filter) {
  var trimmed = safeTrim(filter)
  return trimmed === "" ? "today | overdue" : trimmed
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n)
}

// due.date is either a plain "YYYY-MM-DD" or a full ISO timestamp depending
// on whether the task has a time component. The first 10 characters are the
// date either way.
function isoDatePrefix(dateStr) {
  var s = String(dateStr || "")
  return s.length >= 10 ? s.substring(0, 10) : s
}

// A task's due date as local "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS".
// Floating dates are already local; a task with a fixed timezone comes
// back in UTC ("…T06:30:00Z") and is converted, so sorting and day
// grouping use the time the user actually sees.
function localDue(task) {
  var s = task && task.due && task.due.date ? String(task.due.date) : ""
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) return s
  var d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
    + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
}

function todayIsoDate() {
  var now = new Date()
  return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate())
}

// Prefers Todoist's own human phrasing ("tomorrow at 10:00") and only falls
// back to the raw date when a task has a due date but no string form.
function taskDueLabel(task) {
  if (!task || !task.due) return ""
  return task.due.string || isoDatePrefix(task.due.date)
}

// "#Project  @label1 @label2" line shown under the due date. projectName is
// looked up by the caller (task only carries project_id) and omitted when
// unknown; labels come straight off the task, Todoist's API already gives
// them as name strings rather than ids.
function taskMetaLabel(task, projectName) {
  if (!task) return ""
  var parts = []
  if (projectName) parts.push("#" + projectName)
  var labels = task.labels || []
  for (var i = 0; i < labels.length; i++) parts.push("@" + labels[i])
  return parts.join("  ")
}

// Section heading for one due date in the Next view: "TODAY", "TOMORROW",
// then "WED 14 OCT". Parsed as a local date so the day never shifts with
// the timezone offset.
var DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
var MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

function dayHeading(isoDate) {
  var parts = String(isoDate || "").split("-")
  if (parts.length !== 3) return "NO DATE"
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  var now = new Date()
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  var offset = Math.round((date - today) / 86400000)
  if (offset === 0) return "TODAY"
  if (offset === 1) return "TOMORROW"
  return DAY_NAMES[date.getDay()] + " " + date.getDate() + " " + MONTH_NAMES[date.getMonth()]
}

function taskDueDay(task) {
  return isoDatePrefix(localDue(task))
}

function taskIsOverdue(task) {
  if (!task || !task.due || !task.due.date) return false
  return isoDatePrefix(localDue(task)) < todayIsoDate()
}

// "HH:MM:SS…" part of a timed due date, "" for an all-day task.
function dueTime(task) {
  var s = localDue(task)
  return s.length > 10 ? s.substring(11) : ""
}

// Overdue/due-soonest first, undated tasks last; within a day, timed tasks
// first by time and all-day tasks after them; priority breaks ties within
// the same date, then content for a stable order.
function sortedTasks(tasks) {
  var list = (tasks || []).slice()
  list.sort(function(a, b) {
    var aDue = isoDatePrefix(localDue(a))
    var bDue = isoDatePrefix(localDue(b))
    if (aDue !== bDue) {
      if (aDue === "") return 1
      if (bDue === "") return -1
      return aDue < bDue ? -1 : 1
    }

    // Same day: tasks with a time first, by time; tasks without one last.
    var aTime = dueTime(a)
    var bTime = dueTime(b)
    if (aTime !== bTime) {
      if (aTime === "") return 1
      if (bTime === "") return -1
      return aTime < bTime ? -1 : 1
    }

    var aPriority = a && typeof a.priority === "number" ? a.priority : 1
    var bPriority = b && typeof b.priority === "number" ? b.priority : 1
    if (aPriority !== bPriority) return bPriority - aPriority

    var aContent = (a && a.content) || ""
    var bContent = (b && b.content) || ""
    return aContent < bContent ? -1 : (aContent > bContent ? 1 : 0)
  })
  return list
}

// Relative time for the header's SYNCED stat. `epochMs` is 0 before the
// first successful fetch ever lands.
function formatRelativeTime(epochMs) {
  if (!epochMs) return "never"
  var deltaSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  if (deltaSec < 45) return "just now"
  var deltaMin = Math.round(deltaSec / 60)
  if (deltaMin < 60) return deltaMin + "m ago"
  var deltaHour = Math.round(deltaMin / 60)
  if (deltaHour < 24) return deltaHour + "h ago"
  var deltaDay = Math.round(deltaHour / 24)
  return deltaDay + "d ago"
}

// curl exits non-zero with an empty stdout body on HTTP errors (-f), so the
// only signal available for a friendly message is the exit code and
// whatever curl printed to stderr.
function errorMessageForExit(exitCode, stderrText) {
  var text = String(stderrText || "")
  if (text.indexOf("401") !== -1 || text.indexOf("403") !== -1)
    return "Todoist rejected the API token — check it in Settings."
  if (text.indexOf("Could not resolve host") !== -1 || text.indexOf("Couldn't connect") !== -1
    || text.indexOf("Failed to connect") !== -1 || text.indexOf("Network is unreachable") !== -1)
    return "Couldn't reach Todoist — check your connection."
  if (exitCode === 28) return "Todoist took too long to respond."
  var firstLine = text.split("\n")[0]
  return "Something went wrong talking to Todoist" + (firstLine !== "" ? (": " + firstLine) : ".")
}
