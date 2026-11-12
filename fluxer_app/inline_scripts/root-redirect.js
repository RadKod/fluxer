(() => {
	try {
		const location = window.location;
		const isHandoff = /^#(?:.*&)?handoff=/.test(location.hash);
		if (location.pathname !== '/' || isHandoff) {
			return;
		}
		let target = '/channels/@me';
		// sanalyer: a signed-out visitor opening the bare root on the web lands on the marketing page.
		if (!location.search && !location.hash && !window.electron) {
			let token = null;
			try {
				token = localStorage.getItem('token');
			} catch {}
			if (!token || token === 'undefined' || token === 'null') {
				target = '/marketing';
			}
		}
		location.replace(`${target}${location.search}${location.hash}`);
	} catch {}
})();
