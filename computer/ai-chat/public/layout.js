// Which cockpit layout this page uses, decided before the first paint.
// ?layout=projects (added by the dashboard from the Settings switch) turns on
// the projects column (projects.js); anything else keeps the tab row.
if (new URLSearchParams(location.search).get('layout') === 'projects') {
    document.documentElement.classList.add('layout-projects');
}
