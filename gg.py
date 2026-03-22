import os
from dotenv import load_dotenv
from twilio.rest import Client

load_dotenv()

client = Client(os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"))
number = client.incoming_phone_numbers.list()[0]
print(number.capabilities) 