package gatekeeper

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// AuditQuery is what a kernel sends to POST /v1/audit/query for its admin
// dashboard: records of the last Days days, newest first, that match every
// filter given. User matches a subject or an email.
type AuditQuery struct {
	User      string `json:"user,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	Cell      string `json:"cell,omitempty"`
	Blueprint string `json:"blueprint,omitempty"`
	Decision  string `json:"decision,omitempty"`
	Days      int    `json:"days"`
	Limit     int    `json:"limit"`
	// Only records before this time (RFC 3339), to page back.
	Before string `json:"before,omitempty"`
}

// AuditResult is the answer: the matching records, how many were read to
// find them, and whether reading stopped before the whole range was.
type AuditResult struct {
	Records   []Record `json:"records"`
	Scanned   int      `json:"scanned"`
	Truncated bool     `json:"truncated"`
}

// Each record is an object, so a search reads at most this many, this many
// at a time.
const (
	maxAuditDays    = 31
	maxAuditLimit   = 500
	maxAuditScanned = 5000
	auditReaders    = 16
)

// queryAudit searches the audit log for the asking fleet. A fleet sees only
// its own records: the kernel decides who may search (its platform admins),
// as it vouches for every call.
func (s *Server) queryAudit(w http.ResponseWriter, r *http.Request) {
	body, fleet, ok := s.trusted(w, r)
	if !ok {
		return
	}
	var q AuditQuery
	if err := json.Unmarshal(body, &q); err != nil || q.Days < 1 || q.Days > maxAuditDays || q.Limit < 1 || q.Limit > maxAuditLimit {
		http.Error(w, "malformed query", http.StatusBadRequest)
		return
	}
	before := s.now().UTC().Add(time.Second)
	if q.Before != "" {
		t, err := time.Parse(time.RFC3339Nano, q.Before)
		if err != nil {
			http.Error(w, "before must be RFC 3339", http.StatusBadRequest)
			return
		}
		before = t.UTC()
	}
	res, err := s.searchAudit(r.Context(), fleet, q, before)
	if err != nil {
		s.log().Error("searching the audit log", "err", err)
		http.Error(w, "the audit log is unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) searchAudit(ctx context.Context, fleet string, q AuditQuery, before time.Time) (AuditResult, error) {
	out := AuditResult{Records: []Record{}}
	// Keys sort by time within a day: audit/<yyyy/mm/dd>/<timestamp>-<rand>.json.
	cutoff := "audit/" + before.Format("2006/01/02") + "/" + before.Format("20060102T150405.000000000Z")
	for day := 0; day < q.Days && len(out.Records) < q.Limit; day++ {
		prefix := "audit/" + before.AddDate(0, 0, -day).Format("2006/01/02") + "/"
		keys, err := s.Audit.Store.List(ctx, prefix)
		if err != nil {
			return out, err
		}
		sort.Sort(sort.Reverse(sort.StringSlice(keys)))
		for i := 0; i < len(keys) && len(out.Records) < q.Limit; {
			if out.Scanned >= maxAuditScanned {
				out.Truncated = true
				return out, nil
			}
			batch := keys[i:min(i+auditReaders, len(keys), i+maxAuditScanned-out.Scanned)]
			i += len(batch)
			records := make([]*Record, len(batch))
			var wg sync.WaitGroup
			for j, key := range batch {
				if key >= cutoff {
					continue
				}
				wg.Add(1)
				go func() {
					defer wg.Done()
					data, err := s.Audit.Store.Get(ctx, key)
					var rec Record
					if err == nil && json.Unmarshal(data, &rec) == nil {
						records[j] = &rec
					}
				}()
			}
			wg.Wait()
			for _, rec := range records {
				if rec == nil {
					continue
				}
				out.Scanned++
				if rec.Fleet != fleet || !q.matches(*rec) {
					continue
				}
				if len(out.Records) == q.Limit {
					out.Truncated = true
					continue
				}
				out.Records = append(out.Records, *rec)
			}
		}
	}
	// Stopping at the limit leaves records unread, which may match.
	if len(out.Records) == q.Limit {
		out.Truncated = true
	}
	return out, nil
}

func (q AuditQuery) matches(r Record) bool {
	if q.User != "" && !strings.EqualFold(q.User, r.User) && !strings.EqualFold(q.User, r.Email) {
		return false
	}
	return (q.Workspace == "" || q.Workspace == r.Workspace || strings.HasSuffix(r.Workspace, "/"+q.Workspace)) &&
		(q.Cell == "" || q.Cell == r.Cell) &&
		(q.Blueprint == "" || q.Blueprint == r.Blueprint || strings.HasPrefix(r.Target, q.Blueprint+"@")) &&
		(q.Decision == "" || q.Decision == r.Decision)
}
