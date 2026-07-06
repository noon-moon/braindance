---
tags:
  - scope
Contains: []
Contained By: []
---

Master view of everything tagged `#todo`. A todo is any note carrying the `todo` tag (stacked on its `scope`/`memo` type) with a `status` of open / in-progress / done. See [[Tags]] for the field definitions. Requires the Dataview plugin.

## Overdue & due soon
```dataview
TABLE due, status FROM #todo WHERE status != "done" AND due AND due <= date(today) + dur(7 days) SORT due ASC
```

## In progress
```dataview
TABLE due FROM #todo AND -#recurring WHERE status = "in-progress" SORT due ASC
```

## Open (backlog)
```dataview
TABLE file.ctime AS created FROM #todo AND -#recurring WHERE status = "open" AND (!due OR due > date(today) + dur(7 days)) SORT file.ctime ASC
```

## Recurring — needs a pass
```dataview
TABLE processed FROM #recurring WHERE (date(today) - processed) >= dur("1 day") SORT processed ASC
```

## Done
```dataview
TABLE completed FROM #todo WHERE status = "done" SORT completed DESC
```
