---
tags:
  - daily
---
# {{title}}

## Log


## Due today
```dataview
LIST FROM #todo WHERE due = this.file.day AND status != "done"
```

## Completed today
```dataview
LIST FROM #todo WHERE completed = this.file.link
```
