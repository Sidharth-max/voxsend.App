
async function testUpload() {
    const contacts = [];
    console.log("Generating 150,000 dummy contacts...");
    for (let i = 0; i < 150000; i++) {
        contacts.push({
            name: `User ${i}`,
            phone: `+91${(9000000000 + i).toString()}`,
            group: 'Test Group'
        });
    }

    console.log("Stringifying payload...");
    const body = JSON.stringify(contacts);
    console.log(`Payload size: ${(body.length / 1024 / 1024).toFixed(2)} MB`);

    console.log("Sending POST request to /api/contacts...");
    try {
        const res = await fetch('http://localhost:3002/api/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        });
        const result = await res.json();
        console.log("Response:", result);
    } catch (e) {
        console.error("Error during upload:", e.message);
    }
}

testUpload();
