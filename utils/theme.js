/**
 * Theme Controller Utility for snip8
 * Handles Dark / Light mode switching, persistence in localStorage,
 * system preference detection, and flicker-free initialization.
 */

const THEME_STORAGE_KEY = 'snip8_theme';

export const Snip8Theme = {
    /**
     * Resolves the preferred theme: localStorage > system preference > dark default
     */
    getPreferredTheme() {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        if (saved === 'dark' || saved === 'light') {
            return saved;
        }
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            return 'light';
        }
        return 'dark'; // snip8 default is dark
    },

    /**
     * Apply theme to <html> tag and persist in localStorage
     * @param {'dark'|'light'} theme 
     */
    setTheme(theme) {
        const validTheme = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', validTheme);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, validTheme);
        } catch (e) {
            // Storage quota or sandboxed
        }
        this.updateToggleButtons(validTheme);
        window.dispatchEvent(new CustomEvent('snip8-theme-change', { detail: { theme: validTheme } }));
        return validTheme;
    },

    /**
     * Toggle current theme
     */
    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || this.getPreferredTheme();
        const next = current === 'dark' ? 'light' : 'dark';
        return this.setTheme(next);
    },

    /**
     * Update icon and aria-label on all theme toggle elements
     */
    updateToggleButtons(theme) {
        const buttons = document.querySelectorAll('[data-theme-toggle]');
        buttons.forEach(btn => {
            const isDark = theme === 'dark';
            btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
            btn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
            const iconSpan = btn.querySelector('[data-theme-icon]');
            if (iconSpan) {
                iconSpan.textContent = isDark ? '☀️' : '🌙';
            }
            const labelSpan = btn.querySelector('[data-theme-label]');
            if (labelSpan) {
                labelSpan.textContent = isDark ? 'Light Mode' : 'Dark Mode';
            }
        });
    },

    /**
     * Initialize listeners for toggle buttons and system preference changes
     */
    init() {
        const initialTheme = this.getPreferredTheme();
        this.setTheme(initialTheme);

        // Listen for system theme changes if user hasn't explicitly set a preference
        if (window.matchMedia) {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            mediaQuery.addEventListener('change', (e) => {
                if (!localStorage.getItem(THEME_STORAGE_KEY)) {
                    this.setTheme(e.matches ? 'dark' : 'light');
                }
            });
        }

        // Attach click listeners to all buttons with data-theme-toggle
        document.addEventListener('click', (e) => {
            const toggleBtn = e.target.closest('[data-theme-toggle]');
            if (toggleBtn) {
                this.toggleTheme();
            }
        });
    }
};

// Auto-run if loaded in browser
if (typeof window !== 'undefined') {
    window.Snip8Theme = Snip8Theme;
}
