console.log("Rip Images script running");

function ripImages() {
    const images = document.getElementsByTagName('img');
    const imageUrls = [];
    for (let i = 0; i < images.length; i++) {
        const image = images[i];
        if (image) {
            imageUrls.push(image.src);
        }
    }
    chrome.runtime.sendMessage({imageUrls: imageUrls});
}

ripImages();