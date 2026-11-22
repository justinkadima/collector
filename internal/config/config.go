// Package config stores app-wide settings (not vault data) in the user's
// config directory: last opened workspace, recent workspaces, theme.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Config struct {
	LastWorkspace string   `json:"lastWorkspace"`
	Recent        []string `json:"recent"`
	Theme         string   `json:"theme"`
	SidebarWidth  int      `json:"sidebarWidth"`
}

type Store struct {
	path string
	cfg  Config
}

// Dir is where Collector keeps its own settings. The app used to be called
// not1, so the folder it wrote then is still the user's settings; it is
// carried over the first time Collector starts.
func Dir() string {
	if d, err := os.UserConfigDir(); err == nil && d != "" {
		return filepath.Join(d, "Collector")
	}
	return filepath.Join(os.TempDir(), "collector-config")
}

func Load() *Store {
	s := &Store{path: filepath.Join(Dir(), "config.json")}
	adoptLegacyConfig(filepath.Dir(s.path))
	s.cfg.Theme = "light"
	s.cfg.SidebarWidth = 260
	if b, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(b, &s.cfg)
	}
	if s.cfg.Theme != "dark" && s.cfg.Theme != "light" {
		s.cfg.Theme = "light"
	}
	if s.cfg.SidebarWidth < 180 || s.cfg.SidebarWidth > 520 {
		s.cfg.SidebarWidth = 260
	}
	return s
}

// adoptLegacyConfig copies a not1/config.json into place when Collector has
// none of its own. A copy, not a move: whatever still reads the old folder
// keeps working.
func adoptLegacyConfig(dir string) {
	if _, err := os.Stat(filepath.Join(dir, "config.json")); err == nil {
		return
	}
	old, err := os.ReadFile(filepath.Join(filepath.Dir(dir), "not1", "config.json"))
	if err != nil {
		return
	}
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "config.json"), old, 0o644)
}

func (s *Store) Get() Config {
	c := s.cfg
	c.Recent = append([]string(nil), s.cfg.Recent...)
	return c
}

func (s *Store) Set(fn func(*Config)) {
	fn(&s.cfg)
	if len(s.cfg.Recent) > 12 {
		s.cfg.Recent = s.cfg.Recent[:12]
	}
	_ = os.MkdirAll(filepath.Dir(s.path), 0o755)
	b, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}

func (s *Store) AddRecent(dir string) {
	s.Set(func(c *Config) {
		out := []string{dir}
		for _, d := range c.Recent {
			if d != dir {
				out = append(out, d)
			}
		}
		c.Recent = out
		c.LastWorkspace = dir
	})
}
