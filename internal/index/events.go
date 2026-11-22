package index

import (
	"not1/internal/vault"
)

// Event is a calendar entry as the index knows it: the parsed line plus the
// page it came from, so the calendar can open that page at that line. The file
// remains the only copy; deleting the index loses no events.
type Event struct {
	vault.Event
	Path string `json:"path"`
	Page string `json:"page"`
	Icon string `json:"icon"`
	Type string `json:"type,omitempty"`
}

// Events returns the events with from <= date <= to, all-day ones first, then
// by time. Dates are YYYY-MM-DD, which sorts lexicographically.
func (ix *Index) Events(from, to string) ([]Event, error) {
	rows, err := ix.db.Query(`SELECT e.date, e.start, e.end, e.title, e.line,
			e.path, p.title, p.icon, p.type
		FROM events e JOIN pages p ON p.path = e.path
		WHERE e.date >= ? AND e.date <= ?
		ORDER BY e.date, (e.start='') DESC, e.start, e.title`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.Date, &e.Start, &e.End, &e.Title, &e.Line,
			&e.Path, &e.Page, &e.Icon, &e.Type); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// EventCount counts the events in a range, for a cheap badge.
func (ix *Index) EventCount(from, to string) (int, error) {
	var n int
	err := ix.db.QueryRow(`SELECT count(*) FROM events WHERE date >= ? AND date <= ?`, from, to).Scan(&n)
	return n, err
}
