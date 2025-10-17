const { getCollectionByContract } = require("../api/simplehash");
const { collection: Collection } = require("../models");

const contracts = [
  // "0x80336ad7a747236ef41f47ed2c7641828a480baa",
  "0xeeca64ea9fcf99a22806cd99b3d29cf6e8d54925",
];

const fillCollectionsData = async () => {
  const promises = contracts.map(async (contractAddress) => {
    let next = null;
    const collections = [];
    do {
      const res = await getCollectionByContract({
        chain: 1,
        contract_address: contractAddress,
        include_top_contract_details: 1,
        cursor: next,
      });
      next = res.next_cursor;
      collections.push(res);
    } while (next);

    return collections.map((collection) => {
      return {
        address: contractAddress,
        id: Math.floor(Math.random() * 10000000000),
        image: collection.rawData.openSeaMetadata.imageUrl,
        symbol: collection.symbol,
        floorPrice: collection.rawData.openSeaMetadata.floor_price || 0,
        slug: collection.rawData.openSeaMetadata.slug || "sproto-gremlins",
        totalQuantity: collection.total_quantity || 3333,
        name: collection.name,
      };
    });
  }, 0);

  const dbData = (await Promise.all(promises)).flat();

  await Collection.bulkCreate(dbData);

  console.log("Successfully finished!");
};

fillCollectionsData();
