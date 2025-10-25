chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "setConfidence") {
        const scoreElement = document.getElementById('confidence-score');
        const typeElement = document.getElementById('content-type');
        const scoreCircle = document.querySelector('.score-circle');

        if (request.confidence) {
            const confidence = parseFloat(request.confidence);
            const percentage = Math.round(confidence * 100);

            scoreElement.textContent = `${percentage}%`;
            typeElement.textContent = request.contentType;

            // Update the conic-gradient
            const gradientEnd = percentage;
            scoreCircle.style.background = `conic-gradient(#4CAF50 ${gradientEnd}%, #ddd ${gradientEnd}%)`;

        } else {
            scoreElement.textContent = 'N/A';
            typeElement.textContent = 'Unknown';
            scoreCircle.style.background = `conic-gradient(#ddd 100%, #ddd 100%)`;
        }
    }
});
